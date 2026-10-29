import mongoose from 'mongoose';
import { FoodDeliveryPartner } from '../models/deliveryPartner.model.js';
import { DeliveryLocationLog } from '../models/deliveryLocationLog.model.js';
import { FoodOrder } from '../../orders/models/order.model.js';
import { getRedisClient } from '../../../../config/redis.js';
import { getFirebaseDB } from '../../../../config/firebase.js';
import { getIO, rooms } from '../../../../config/socket.js';
import { logger } from '../../../../utils/logger.js';

export const processDriverLocationBatch = async (deliveryPartnerId, payload = {}) => {
    const startTime = Date.now();
    console.log('\n==================== 🛵 DRIVER LOCATION RECEIVED 🛵 ====================');
    console.log(`⏱️ Time: ${new Date().toLocaleTimeString()} | Driver: ${deliveryPartnerId}`);

    if (!deliveryPartnerId) {
        console.error('❌ [LOCATION_TRACKING] Missing deliveryPartnerId');
        throw new Error('Delivery partner ID is required');
    }

    const partnerObjectId = new mongoose.Types.ObjectId(deliveryPartnerId);

    // 1. Normalize locations array
    let rawLocations = [];
    if (Array.isArray(payload.locations)) {
        rawLocations = payload.locations;
    } else if (Array.isArray(payload)) {
        rawLocations = payload;
    } else if (payload.lat != null && payload.lng != null) {
        rawLocations = [payload];
    } else if (payload.locations && typeof payload.locations === 'object') {
        rawLocations = [payload.locations];
    }

    console.log(`📦 Coordinates count: ${rawLocations.length} points`);

    // 2. Fetch driver profile & active order
    const [partner, activeOrder] = await Promise.all([
        FoodDeliveryPartner.findById(deliveryPartnerId).select('status availabilityStatus lastLocationAt name phone zoneId').lean(),
        FoodOrder.findOne({
            'dispatch.deliveryPartnerId': partnerObjectId,
            orderStatus: { $in: ['accepted', 'confirmed', 'reached_pickup', 'picked_up', 'out_for_delivery', 'reached_drop'] }
        }).select('_id orderId orderStatus user restaurantId').lean()
    ]);

    if (!partner) {
        console.error(`❌ [LOCATION_TRACKING] Driver not found: ${deliveryPartnerId}`);
        throw new Error('Delivery partner not found');
    }

    if (activeOrder) {
        console.log(`🚀 Active Order: ${activeOrder.orderId || activeOrder._id} (Status: ${activeOrder.orderStatus})`);
    } else {
        console.log('ℹ️ State: Online / Idle (No active trip)');
    }

    // 3. Filter & validate incoming coordinates
    const validPoints = [];
    for (const item of rawLocations) {
        const lat = Number(item.lat ?? item.latitude);
        const lng = Number(item.lng ?? item.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        if (lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;

        let capturedAt = item.capturedAt ? new Date(item.capturedAt) : new Date();
        if (isNaN(capturedAt.getTime())) capturedAt = new Date();

        const pointOrderId = item.orderId 
            ? (mongoose.Types.ObjectId.isValid(item.orderId) ? new mongoose.Types.ObjectId(item.orderId) : null)
            : (activeOrder?._id || null);

        validPoints.push({
            deliveryPartnerId: partnerObjectId,
            orderId: pointOrderId,
            location: { type: 'Point', coordinates: [lng, lat] },
            lat,
            lng,
            speed: item.speed != null ? Number(item.speed) : null,
            heading: item.heading != null ? Number(item.heading) : (item.bearing != null ? Number(item.bearing) : null),
            accuracy: item.accuracy != null ? Number(item.accuracy) : null,
            altitude: item.altitude != null ? Number(item.altitude) : null,
            battery: item.battery != null ? Number(item.battery) : null,
            capturedAt
        });
    }

    // Sort chronologically
    validPoints.sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime());

    let processedCount = 0;
    if (validPoints.length > 0) {
        // 4. Bulk Upsert Breadcrumbs to MongoDB
        try {
            const bulkOps = validPoints.map(pt => ({
                updateOne: {
                    filter: { deliveryPartnerId: pt.deliveryPartnerId, capturedAt: pt.capturedAt },
                    update: {
                        $setOnInsert: {
                            deliveryPartnerId: pt.deliveryPartnerId,
                            orderId: pt.orderId,
                            location: pt.location,
                            speed: pt.speed,
                            heading: pt.heading,
                            accuracy: pt.accuracy,
                            altitude: pt.altitude,
                            battery: pt.battery,
                            capturedAt: pt.capturedAt
                        }
                    },
                    upsert: true
                }
            }));
            const bulkRes = await DeliveryLocationLog.bulkWrite(bulkOps, { ordered: false });
            processedCount = (bulkRes.upsertedCount || 0) + (bulkRes.modifiedCount || 0) + (bulkRes.matchedCount || 0);
        } catch (dbErr) {
            processedCount = validPoints.length;
        }

        // 5. Newest point sync
        const newestPoint = validPoints[validPoints.length - 1];
        const lastKnownTime = partner.lastLocationAt ? new Date(partner.lastLocationAt).getTime() : 0;
        const isNewest = newestPoint.capturedAt.getTime() >= lastKnownTime;

        console.log(`📍 GPS Coordinates: Lat=${newestPoint.lat}, Lng=${newestPoint.lng} | Heading=${newestPoint.heading}° | Speed=${newestPoint.speed}km/h`);

        if (isNewest) {
            const now = newestPoint.capturedAt.getTime();
            const coordPayload = {
                lat: newestPoint.lat,
                lng: newestPoint.lng,
                speed: newestPoint.speed || 0,
                heading: newestPoint.heading || 0,
                accuracy: newestPoint.accuracy,
                timestamp: now
            };

            // A. MongoDB Driver Profile
            const isApproved = partner.status === 'approved';
            const isExplicitlyOffline = payload.status === 'offline' || payload.isOnline === false || payload.is_online === false;
            const isOnline = isApproved && !isExplicitlyOffline;

            FoodDeliveryPartner.findByIdAndUpdate(deliveryPartnerId, {
                $set: {
                    lastLat: newestPoint.lat,
                    lastLng: newestPoint.lng,
                    lastLocation: newestPoint.location,
                    lastLocationAt: newestPoint.capturedAt,
                    lastHeading: newestPoint.heading || 0,
                    lastSpeed: newestPoint.speed || 0,
                    ...(isOnline ? { availabilityStatus: 'online' } : (isExplicitlyOffline ? { availabilityStatus: 'offline' } : {}))
                }
            }).catch(e => logger.error(`[LocationBatch] Mongo update error: ${e.message}`));

            // B. Redis Hot Cache
            try {
                const redis = getRedisClient();
                if (redis) {
                    const coordString = JSON.stringify(coordPayload);
                    const redisOps = [redis.hSet('rider:locations:hot', String(deliveryPartnerId), coordString)];
                    if (activeOrder) {
                        redisOps.push(redis.hSet('order:locations:hot', String(activeOrder.orderId || activeOrder._id), coordString));
                    }
                    await Promise.all(redisOps);
                }
            } catch (rErr) {}

            // C. Firebase Realtime Database
            try {
                const firebaseDB = getFirebaseDB();
                if (firebaseDB) {
                    // Update delivery boy
                    firebaseDB.ref(`delivery_boys/${deliveryPartnerId}`).update({
                        lat: newestPoint.lat,
                        lng: newestPoint.lng,
                        heading: newestPoint.heading || 0,
                        speed: newestPoint.speed || 0,
                        accuracy: newestPoint.accuracy || 0,
                        last_updated: now,
                        timestamp: now,
                        status: isOnline ? 'online' : 'offline',
                        availabilityStatus: isOnline ? 'online' : 'offline',
                        is_online: isOnline,
                        isOnline: isOnline,
                        name: partner.name || '',
                        phone: partner.phone || '',
                        zoneId: partner.zoneId ? String(partner.zoneId) : null,
                        active_order_id: activeOrder ? String(activeOrder.orderId || activeOrder._id) : null
                    }).catch(() => {});

                    // Update active order
                    if (activeOrder) {
                        const orderKeys = [String(activeOrder._id)];
                        if (activeOrder.orderId && String(activeOrder.orderId) !== String(activeOrder._id)) {
                            orderKeys.push(String(activeOrder.orderId));
                        }
                        for (const key of orderKeys) {
                            firebaseDB.ref(`active_orders/${key}`).update({
                                lat: newestPoint.lat,
                                lng: newestPoint.lng,
                                heading: newestPoint.heading || 0,
                                speed: newestPoint.speed || 0,
                                accuracy: newestPoint.accuracy || 0,
                                last_updated: now,
                                status: activeOrder.orderStatus || 'on_the_way'
                            }).catch(() => {});
                        }
                    }
                }
            } catch (fErr) {}

            // D. Socket.IO Live Broadcast
            try {
                const io = getIO();
                if (io) {
                    const trackingBroadcast = {
                        orderId: activeOrder ? String(activeOrder._id) : null,
                        order_id: activeOrder ? String(activeOrder._id) : null,
                        customOrderId: activeOrder?.orderId || null,
                        trackingId: activeOrder ? String(activeOrder._id) : null,
                        deliveryPartnerId: String(deliveryPartnerId),
                        driverId: String(deliveryPartnerId),
                        ...coordPayload,
                        status: activeOrder?.orderStatus || (isOnline ? 'online' : 'offline')
                    };

                    // Broadcast to admin room for real-time map tracking
                    const adminBroadcast = {
                        deliveryPartnerId: String(deliveryPartnerId),
                        _id: String(deliveryPartnerId),
                        name: partner.name || 'Delivery Partner',
                        phone: partner.phone || 'N/A',
                        zoneId: partner.zoneId ? String(partner.zoneId) : null,
                        lat: newestPoint.lat,
                        lng: newestPoint.lng,
                        heading: newestPoint.heading || 0,
                        speed: newestPoint.speed || 0,
                        accuracy: newestPoint.accuracy || 0,
                        status: isOnline ? 'online' : 'offline',
                        isOnline: isOnline,
                        timestamp: now,
                        lastUpdate: now,
                        activeOrderId: activeOrder ? String(activeOrder.orderId || activeOrder._id) : null
                    };
                    io.to(rooms.admin()).emit('rider-location-update', adminBroadcast);

                    if (activeOrder) {
                        io.to(rooms.tracking(activeOrder._id.toString())).emit('location-update', trackingBroadcast);
                        if (activeOrder.orderId && activeOrder.orderId !== activeOrder._id.toString()) {
                            io.to(rooms.tracking(activeOrder.orderId)).emit('location-update', trackingBroadcast);
                        }
                        if (activeOrder.user) {
                            const userId = activeOrder.user?._id?.toString() || activeOrder.user?.toString();
                            if (userId) io.to(rooms.user(userId)).emit('location-update', trackingBroadcast);
                        }
                        if (activeOrder.restaurantId) {
                            const restId = activeOrder.restaurantId?._id?.toString() || activeOrder.restaurantId?.toString();
                            if (restId) io.to(rooms.restaurant(restId)).emit('location-update', trackingBroadcast);
                        }
                    }
                }
            } catch (sErr) {}
        }
    }

    // 6. Dynamic Configuration
    const hasActiveTrip = Boolean(activeOrder);

    let mode = 'idle';
    let stopTracking = false;
    let intervalMs = 15000;
    let distanceFilterMeters = 30;

    if (!isApproved || (!isOnline && !hasActiveTrip)) {
        stopTracking = true;
        mode = 'offline';
        intervalMs = 30000;
        distanceFilterMeters = 100;
    } else if (hasActiveTrip) {
        mode = 'onTrip';
        stopTracking = false;
        intervalMs = 8000; // 8s cadence on trip
        distanceFilterMeters = 15; // 15m filter
    } else {
        mode = 'idle';
        stopTracking = false;
        intervalMs = 15000; // 15s cadence when idle online
        distanceFilterMeters = 30; // 30m filter
    }

    const duration = Date.now() - startTime;
    console.log(`✅ Processed in ${duration}ms | Mode: ${mode} | stopTracking: ${stopTracking}`);
    console.log('=========================================================================\n');

    return {
        processedCount: validPoints.length,
        totalReceived: rawLocations.length,
        activeOrderId: activeOrder ? (activeOrder.orderId || activeOrder._id) : null,
        config: {
            stopTracking,
            mode,
            intervalMs,
            distanceFilterMeters
        }
    };
};
