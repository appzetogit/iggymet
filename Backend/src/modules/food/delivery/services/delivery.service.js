import mongoose from 'mongoose';
import { FoodDeliveryPartner } from '../models/deliveryPartner.model.js';
import { DeliverySupportTicket } from '../models/supportTicket.model.js';
import { DeliveryBonusTransaction } from '../../admin/models/deliveryBonusTransaction.model.js';
import { FoodPayoutSettlement } from '../../admin/models/foodPayoutSettlement.model.js';
import { FoodEarningAddon } from '../../admin/models/earningAddon.model.js';
import { FoodOrder } from '../../orders/models/order.model.js';
import { FoodZone } from '../../admin/models/zone.model.js';
import { sanitizeOrderForExternal } from '../../orders/services/order.helpers.js';
import { uploadImageBuffer } from '../../../../services/cloudinary.service.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import { getDeliveryCashLimitSettings } from '../../admin/services/admin.service.js';

const PAYABLE_DELIVERY_STATUSES = ['delivered', 'cancelled_by_user_unavailable'];

export const registerDeliveryPartner = async (payload, files) => {
    const { 
        name, phone, email, countryCode, address, city, state, 
        vehicleType, vehicleName, vehicleNumber, drivingLicenseNumber, panNumber, aadharNumber,
        fcmToken, platform 
    } = payload;
    const refRaw = typeof payload?.ref === 'string' ? String(payload.ref).trim() : '';

    const existing = await FoodDeliveryPartner.findOne({ phone });
    if (existing) {
        if (existing.status !== 'rejected') {
            throw new ValidationError('Delivery partner with this phone already exists');
        }
        // If rejected, delete the old record so they can start fresh with same phone
        await FoodDeliveryPartner.deleteMany({ phone });
    }

    const images = {};

    if (files?.profilePhoto?.[0]) {
        images.profilePhoto = await uploadImageBuffer(files.profilePhoto[0].buffer, 'food/delivery/profile');
    }
    if (files?.aadharPhoto?.[0]) {
        images.aadharPhoto = await uploadImageBuffer(files.aadharPhoto[0].buffer, 'food/delivery/aadhar');
    }
    if (files?.panPhoto?.[0]) {
        images.panPhoto = await uploadImageBuffer(files.panPhoto[0].buffer, 'food/delivery/pan');
    }
    if (files?.drivingLicensePhoto?.[0]) {
        images.drivingLicensePhoto = await uploadImageBuffer(
            files.drivingLicensePhoto[0].buffer,
            'food/delivery/license'
        );
    }

    const partner = await FoodDeliveryPartner.create({
        name,
        phone,
        email: email && String(email).trim() ? String(email).trim() : undefined,
        countryCode,
        address,
        city,
        state,
        vehicleType,
        vehicleName,
        vehicleNumber,
        drivingLicenseNumber,
        panNumber,
        aadharNumber,
        status: 'pending',
        ...images
    });

    // Update FCM token if provided
    if (fcmToken) {
        if (platform === 'mobile') {
            partner.fcmTokenMobile = [fcmToken];
        } else {
            partner.fcmTokens = [fcmToken];
        }
    }

    // Ensure referralCode exists for sharing.
    if (!partner.referralCode) {
        partner.referralCode = String(partner._id);
    }

    // Store referredBy (no credit here; credit happens on admin approval).
    if (refRaw && mongoose.Types.ObjectId.isValid(refRaw) && String(refRaw) !== String(partner._id)) {
        const referrer = await FoodDeliveryPartner.findById(refRaw).select('_id').lean();
        if (referrer) {
            partner.referredBy = referrer._id;
        }
    }

    await partner.save();

    try {
        const { notifyAdminsSafely } = await import('../../../../core/notifications/firebase.service.js');
        void notifyAdminsSafely({
            title: 'New Delivery Partner Registration 🚲',
            body: `A new delivery partner "${partner.name}" has signed up and is pending approval.`,
            data: {
                type: 'new_registration',
                subType: 'delivery_partner',
                id: String(partner._id)
            }
        });
    } catch (e) {
        // eslint-disable-next-line no-console
        console.error('Failed to notify admins of new delivery partner registration:', e);
    }

    return partner.toObject();
};

export const updateDeliveryPartnerProfile = async (userId, payload, files) => {
    const partner = await FoodDeliveryPartner.findById(userId);
    if (!partner) {
        throw new ValidationError('Delivery partner not found');
    }

    let requiresReapproval = false;

    const {
        name, countryCode, address, city, state,
        vehicleType, vehicleName, vehicleNumber, drivingLicenseNumber, panNumber, aadharNumber,
        fcmToken, platform
    } = payload;

    // Update profile fields (no approval needed)
    if (name) partner.name = name;
    if (countryCode !== undefined) partner.countryCode = countryCode;
    if (address !== undefined) partner.address = address;
    if (city !== undefined) partner.city = city;
    if (state !== undefined) partner.state = state;
    if (vehicleType !== undefined) partner.vehicleType = vehicleType;
    if (vehicleName !== undefined) partner.vehicleName = vehicleName;
    if (vehicleNumber !== undefined) partner.vehicleNumber = vehicleNumber;

    // Handle document changes - store in pending and require approval
    if (aadharNumber !== undefined || panNumber !== undefined || drivingLicenseNumber !== undefined) {
        if (!partner.pendingDocuments) {
            partner.pendingDocuments = {};
        }
        
        if (aadharNumber !== undefined && String(aadharNumber).trim() !== String(partner.aadharNumber || '').trim()) {
            partner.pendingDocuments.aadharNumber = String(aadharNumber).trim();
            requiresReapproval = true;
        }
        if (panNumber !== undefined && String(panNumber).trim() !== String(partner.panNumber || '').trim()) {
            partner.pendingDocuments.panNumber = String(panNumber).trim().toUpperCase();
            requiresReapproval = true;
        }
        if (drivingLicenseNumber !== undefined && String(drivingLicenseNumber).trim() !== String(partner.drivingLicenseNumber || '').trim()) {
            partner.pendingDocuments.drivingLicenseNumber = String(drivingLicenseNumber).trim().toUpperCase();
            requiresReapproval = true;
        }

        if (requiresReapproval) {
            partner.documentsChangeRequestedAt = new Date();
            partner.status = 'pending';
        }
    }

    if (fcmToken) {
        if (platform === 'mobile') {
            if (!partner.fcmTokenMobile) partner.fcmTokenMobile = [];
            if (!partner.fcmTokenMobile.includes(fcmToken)) {
                partner.fcmTokenMobile.push(fcmToken);
            }
        } else {
            if (!partner.fcmTokens) partner.fcmTokens = [];
            if (!partner.fcmTokens.includes(fcmToken)) {
                partner.fcmTokens.push(fcmToken);
            }
        }
    }

    if (files?.profilePhoto?.[0]) {
        partner.profilePhoto = await uploadImageBuffer(files.profilePhoto[0].buffer, 'food/delivery/profile');
    }

    await partner.save();
    return {
        partner: partner.toObject(),
        requiresReapproval: requiresReapproval
    };
};

export const updateDeliveryPartnerDetails = async (userId, payload) => {
    const partner = await FoodDeliveryPartner.findById(userId);
    if (!partner) {
        throw new ValidationError('Delivery partner not found');
    }

    let requiresReapproval = false;
    const previousZoneId = String(partner.zoneId || '');

    const vehicle = payload?.vehicle;
    if (vehicle && typeof vehicle === 'object') {
        if (vehicle.number !== undefined) partner.vehicleNumber = String(vehicle.number || '').trim();
        if (vehicle.type !== undefined) partner.vehicleType = String(vehicle.type || '').trim();
        if (vehicle.brand !== undefined) partner.vehicleName = String(vehicle.brand || '').trim();
        if (vehicle.model !== undefined) partner.vehicleName = String(vehicle.model || '').trim();
    }

    if (payload?.profilePhoto !== undefined) {
        partner.profilePhoto = payload.profilePhoto ? String(payload.profilePhoto).trim() : '';
    }

    // Handle zone update
    if (payload?.zoneId !== undefined) {
        const rawZoneId = String(payload.zoneId || '').trim();
        if (rawZoneId) {
            if (!mongoose.Types.ObjectId.isValid(rawZoneId)) {
                throw new ValidationError('Invalid zoneId format');
            }
            const zone = await FoodZone.findById(rawZoneId).select('_id isActive').lean();
            if (!zone) {
                throw new ValidationError('Zone not found');
            }
            if (zone.isActive === false) {
                throw new ValidationError('Cannot assign inactive zone');
            }
            const newZoneId = String(zone._id || '');
            if (newZoneId !== previousZoneId) {
                // Store pending zone change for admin approval
                partner.pendingZoneId = new mongoose.Types.ObjectId(rawZoneId);
                partner.zoneChangeRequestedAt = new Date();
                partner.status = 'pending';
                requiresReapproval = true;
            }
        } else if (previousZoneId) {
            partner.pendingZoneId = null;
            partner.zoneChangeRequestedAt = null;
        }
    }

    await partner.save();
    return {
        partner: partner.toObject(),
        requiresReapproval: requiresReapproval
    };
};

export const updateDeliveryPartnerProfilePhotoBase64 = async (userId, payload) => {
    const partner = await FoodDeliveryPartner.findById(userId);
    if (!partner) {
        throw new ValidationError('Delivery partner not found');
    }
    const base64 = payload?.base64;
    const mimeType = payload?.mimeType || 'image/jpeg';
    if (!base64 || typeof base64 !== 'string') {
        throw new ValidationError('base64 is required');
    }
    const buffer = Buffer.from(base64, 'base64');
    if (!buffer || !buffer.length) {
        throw new ValidationError('Invalid base64 image');
    }
    if (buffer.length > 8 * 1024 * 1024) {
        throw new ValidationError('Image too large (max 8MB)');
    }
    partner.profilePhoto = await uploadImageBuffer(buffer, 'food/delivery/profile');
    await partner.save();
    return partner.toObject();
};

export const updateDeliveryPartnerBankDetails = async (userId, payload, files) => {
    const partner = await FoodDeliveryPartner.findById(userId);
    if (!partner) {
        throw new ValidationError('Delivery partner not found');
    }

    let requiresReapproval = false;

    // Handle both nested JSON and flat FormData from multer
    let bankDetails = payload?.documents?.bankDetails;
    let panDetails = payload?.documents?.pan;

    // Multer flattens FormData keys like 'documents[bankDetails][accountNumber]'
    if (!bankDetails && payload) {
        const b = {};
        if (payload['documents[bankDetails][accountHolderName]'] !== undefined) b.accountHolderName = payload['documents[bankDetails][accountHolderName]'];
        if (payload['documents[bankDetails][accountNumber]'] !== undefined) b.accountNumber = payload['documents[bankDetails][accountNumber]'];
        if (payload['documents[bankDetails][ifscCode]'] !== undefined) b.ifscCode = payload['documents[bankDetails][ifscCode]'];
        if (payload['documents[bankDetails][bankName]'] !== undefined) b.bankName = payload['documents[bankDetails][bankName]'];
        if (payload['documents[bankDetails][upiId]'] !== undefined) b.upiId = payload['documents[bankDetails][upiId]'];
        if (Object.keys(b).length > 0) bankDetails = b;
    }

    if (!panDetails && payload?.['documents[pan][number]'] !== undefined) {
        panDetails = { number: payload['documents[pan][number]'] };
    }

    if (bankDetails) {
        const b = bankDetails;
        if (b.accountHolderName !== undefined) partner.bankAccountHolderName = b.accountHolderName ? String(b.accountHolderName).trim() : '';
        if (b.accountNumber !== undefined) partner.bankAccountNumber = b.accountNumber ? String(b.accountNumber).trim() : '';
        if (b.ifscCode !== undefined) partner.bankIfscCode = b.ifscCode ? String(b.ifscCode).trim().toUpperCase() : '';
        if (b.bankName !== undefined) partner.bankName = b.bankName ? String(b.bankName).trim() : '';
        if (b.upiId !== undefined) partner.upiId = b.upiId ? String(b.upiId).trim() : '';
    }

    if (panDetails?.number !== undefined) {
        const newPan = panDetails.number ? String(panDetails.number).trim().toUpperCase() : '';
        if (newPan !== String(partner.panNumber || '').trim().toUpperCase()) {
            if (!partner.pendingDocuments) partner.pendingDocuments = {};
            partner.pendingDocuments.panNumber = newPan;
            partner.documentsChangeRequestedAt = new Date();
            partner.status = 'pending';
            requiresReapproval = true;
        }
    }

    if (files?.upiQrCode?.[0]) {
        partner.upiQrCode = await uploadImageBuffer(files.upiQrCode[0].buffer, 'food/delivery/upi');
    }

    await partner.save();
    return {
        partner: partner.toObject(),
        requiresReapproval
    };
};

function generateTicketId() {
    const n = Date.now().toString(36).slice(-6).toUpperCase();
    const r = Math.random().toString(36).slice(2, 6).toUpperCase();
    return `TKT-${n}${r}`;
}

export const listSupportTicketsByPartner = async (deliveryPartnerId) => {
    const list = await DeliverySupportTicket.find({ deliveryPartnerId })
        .sort({ createdAt: -1 })
        .lean();
    return list;
};

export const createSupportTicket = async (deliveryPartnerId, payload) => {
    const { subject, description, category = 'other', priority = 'medium' } = payload;
    if (!subject || !description || subject.trim().length < 3) {
        throw new ValidationError('Subject is required (min 3 characters)');
    }
    if (description.trim().length < 10) {
        throw new ValidationError('Description must be at least 10 characters');
    }
    let ticketId = generateTicketId();
    let exists = await DeliverySupportTicket.findOne({ ticketId }).lean();
    while (exists) {
        ticketId = generateTicketId();
        exists = await DeliverySupportTicket.findOne({ ticketId }).lean();
    }
    const ticket = await DeliverySupportTicket.create({
        deliveryPartnerId,
        ticketId,
        subject: subject.trim(),
        description: description.trim(),
        category: ['payment', 'account', 'technical', 'order', 'other'].includes(category) ? category : 'other',
        priority: ['low', 'medium', 'high', 'urgent'].includes(priority) ? priority : 'medium',
        status: 'open'
    });
    return ticket.toObject();
};

export const getSupportTicketByIdAndPartner = async (ticketId, deliveryPartnerId) => {
    const ticket = await DeliverySupportTicket.findOne({
        _id: ticketId,
        deliveryPartnerId
    }).lean();
    return ticket;
};

export const getDeliveryPartnerReviews = async (deliveryPartnerId, query = {}) => {
    if (!deliveryPartnerId || !mongoose.Types.ObjectId.isValid(deliveryPartnerId)) {
        throw new ValidationError('Delivery partner not found');
    }

    const partnerId = new mongoose.Types.ObjectId(deliveryPartnerId);
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 100, 1), 500);
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const skip = (page - 1) * limit;
    const filter = {
        'dispatch.deliveryPartnerId': partnerId,
        'ratings.deliveryPartner.rating': { $exists: true, $ne: null }
    };

    const [orders, total, aggregate] = await Promise.all([
        FoodOrder.find(filter)
            .sort({ 'ratings.deliveryPartner.ratedAt': -1, createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate('userId', 'name phone profileImage')
            .populate('restaurantId', 'restaurantName profileImage area city')
            .select('orderId userId restaurantId ratings.deliveryPartner createdAt deliveryState.deliveredAt')
            .lean(),
        FoodOrder.countDocuments(filter),
        FoodOrder.aggregate([
            { $match: filter },
            {
                $group: {
                    _id: null,
                    averageRating: { $avg: '$ratings.deliveryPartner.rating' },
                    totalRatings: { $sum: 1 }
                }
            }
        ])
    ]);

    const reviews = orders.map((order, index) => {
        const rating = order?.ratings?.deliveryPartner || {};
        return {
            sl: skip + index + 1,
            orderId: order.orderId,
            customer: order.userId?.name || 'Customer',
            restaurant: order.restaurantId?.restaurantName || 'Restaurant',
            restaurantArea: [order.restaurantId?.area, order.restaurantId?.city].filter(Boolean).join(', '),
            rating: Number(rating.rating) || 0,
            review: rating.comment || '',
            submittedAt: rating.ratedAt || order.createdAt,
            deliveredAt: order.deliveryState?.deliveredAt || null
        };
    });

    return {
        reviews,
        total,
        page,
        limit,
        averageRating: Number(aggregate?.[0]?.averageRating || 0),
        totalRatings: Number(aggregate?.[0]?.totalRatings || 0)
    };
};

export const updateDeliveryAvailability = async (userId, payload) => {
    const partner = await FoodDeliveryPartner.findById(userId);
    if (!partner) {
        throw new ValidationError('Delivery partner not found');
    }
    
    const { status, latitude, longitude } = payload || {};
    let validStatus = 'offline';
    
    if (status === 'online' || status === true) {
        if (partner.status !== 'approved') {
            throw new ValidationError('Your account is not approved yet. Please wait for admin verification.');
        }
        validStatus = 'online';
    } else if (status === 'offline' || status === false) {
        validStatus = 'offline';
    }
    
    partner.availabilityStatus = validStatus;
    if (typeof latitude === 'number' && typeof longitude === 'number') {
        partner.lastLocation = {
            type: 'Point',
            coordinates: [longitude, latitude]
        };
        partner.lastLat = latitude;
        partner.lastLng = longitude;
        partner.lastHeading = Number(payload?.heading) || 0;
        partner.lastSpeed = Number(payload?.speed) || 0;
        partner.lastLocationAt = new Date();
    }
    await partner.save();
    // Sync to Firebase Realtime Database and Socket for live admin tracking
    try {
        const { getFirebaseDB } = await import('../../../../config/firebase.js');
        const firebaseDB = getFirebaseDB();
        if (firebaseDB) {
            const now = Date.now();
            const isOnlineVal = validStatus === 'online';
            const hasCoordinates = typeof latitude === 'number' && typeof longitude === 'number';
            const updateData = {
                status: validStatus,
                availabilityStatus: validStatus,
                is_online: isOnlineVal,
                isOnline: isOnlineVal,
                last_updated: now,
                timestamp: now,
                name: partner.name || '',
                phone: partner.phone || '',
                zoneId: partner.zoneId ? String(partner.zoneId) : null
            };
            if (hasCoordinates) {
                updateData.lat = latitude;
                updateData.lng = longitude;
                updateData.heading = Number(payload?.heading) || 0;
                updateData.speed = Number(payload?.speed) || 0;
                updateData.accuracy = Number(payload?.accuracy) || 0;
            }
            firebaseDB.ref(`delivery_boys/${userId}`).update(updateData).catch(() => {});
        }
    } catch (fErr) {}

    try {
        const { getIO, rooms } = await import('../../../../config/socket.js');
        const io = getIO();
        if (io) {
            const now = Date.now();
            const isOnlineVal = validStatus === 'online';
            const hasCoordinates = typeof latitude === 'number' && typeof longitude === 'number';
            io.to(rooms.admin()).emit('rider-location-update', {
                deliveryPartnerId: String(userId),
                _id: String(userId),
                name: partner.name || 'Delivery Partner',
                phone: partner.phone || 'N/A',
                zoneId: partner.zoneId ? String(partner.zoneId) : null,
                lat: hasCoordinates ? latitude : partner.lastLat,
                lng: hasCoordinates ? longitude : partner.lastLng,
                heading: Number(payload?.heading) || partner.lastHeading || 0,
                speed: Number(payload?.speed) || partner.lastSpeed || 0,
                status: validStatus,
                isOnline: isOnlineVal,
                timestamp: now,
                lastUpdate: now
            });
        }
    } catch (sErr) {}

    return { availabilityStatus: partner.availabilityStatus };
};

// ----- Delivery partner wallet (Pocket / requests page) -----
export const getDeliveryPartnerWallet = async (deliveryPartnerId) => {
    if (!deliveryPartnerId || !mongoose.Types.ObjectId.isValid(deliveryPartnerId)) {
        throw new ValidationError('Delivery partner not found');
    }
    const partner = await FoodDeliveryPartner.findById(deliveryPartnerId).lean();
    if (!partner) {
        throw new ValidationError('Delivery partner not found');
    }

    const partnerId = new mongoose.Types.ObjectId(deliveryPartnerId);

    // Earnings paid to rider through completed deliveries
    const [earningsAgg, cashAgg] = await Promise.all([
        FoodOrder.aggregate([
            {
                $match: {
                    'dispatch.deliveryPartnerId': partnerId,
                    orderStatus: { $in: PAYABLE_DELIVERY_STATUSES },
                }
            },
            {
                $group: {
                    _id: null,
                    totalEarned: { $sum: { $ifNull: ['$riderEarning', 0] } }
                }
            }
        ]),
        FoodOrder.aggregate([
            {
                $match: {
                    'dispatch.deliveryPartnerId': partnerId,
                    orderStatus: 'delivered',
                    'payment.method': 'cash',
                    'payment.status': 'paid'
                }
            },
            {
                $group: {
                    _id: null,
                    cashInHand: { $sum: { $ifNull: ['$riderEarning', 0] } }
                }
            }
        ])
    ]);

    const totalEarned = Number(earningsAgg?.[0]?.totalEarned) || 0;
    const cashInHand = Number(cashAgg?.[0]?.cashInHand) || 0;
    const cashLimitSettings = await getDeliveryCashLimitSettings({
        zoneId: partner?.zoneId,
        deliveryPartnerId,
    });
    const totalCashLimit = Number(
        cashLimitSettings.effectiveDeliveryCashLimit ?? cashLimitSettings.deliveryCashLimit,
    ) || 0;
    const deliveryWithdrawalLimit = 0;

    // Admin-set delivery bonuses / earning addons
    const bonusAgg = await DeliveryBonusTransaction.aggregate([
        { $match: { deliveryPartnerId: partnerId, status: { $ne: 'pending' } } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    const totalBonus = bonusAgg?.[0] ? Number(bonusAgg[0].total) : 0;

    // Keep transactions list reasonably small (UI only needs recent data for charts)
    const [paymentTxList, bonusTxList] = await Promise.all([
        FoodOrder.find({
            'dispatch.deliveryPartnerId': partnerId,
            orderStatus: { $in: PAYABLE_DELIVERY_STATUSES },
        })
            .sort({ 'deliveryState.deliveredAt': -1, createdAt: -1 })
            .select('orderId riderEarning payment orderStatus deliveryState createdAt updatedAt deliveryState.deliveredAt')
            .limit(2000)
            .lean(),
        DeliveryBonusTransaction.find({ deliveryPartnerId: partnerId })
            .sort({ createdAt: -1 })
            .limit(1000)
            .lean(),
    ]);

    const paymentTransactions = (paymentTxList || []).map((o) => {
        const deliveredAt = o?.deliveryState?.deliveredAt || o?.deliveredAt || null;
        const date = deliveredAt || o?.createdAt || new Date();
        return {
            _id: o._id,
            type: 'payment',
            amount: Number(o.riderEarning) || 0,
            status: 'Completed',
            date,
            createdAt: date,
            orderId: o.orderId || String(o._id),
            paymentMethod: o?.payment?.method || '',
            metadata: { orderId: o.orderId || String(o._id) },
            description: o?.payment?.method === 'cash' ? 'COD delivery earning' : 'Online delivery earning'
        };
    });

    // Frontend weekly earnings expects bonus transactions as `earning_addon`.
    const bonusTransactions = (bonusTxList || []).map((t) => ({
        _id: t._id,
        type: 'earning_addon',
        amount: Number(t.amount) || 0,
        status: String(t.status || '').toLowerCase() === 'pending' ? 'Pending' : 'Completed',
        date: t.createdAt,
        createdAt: t.createdAt,
        metadata: { reference: t.reference || '' },
        description: t.reference ? `Bonus - ${t.reference}` : 'Bonus'
    }));

    const totalWithdrawn = 0;
    const totalBalance = totalEarned + totalBonus;
    const availableCashLimit = Math.max(0, totalCashLimit - cashInHand);

    return {
        totalBalance,
        pocketBalance: totalBalance,
        cashInHand,
        totalWithdrawn,
        totalEarned,
        totalCashLimit,
        availableCashLimit,
        deliveryWithdrawalLimit,
        cashLimitZoneId: String(cashLimitSettings.zoneId || partner?.zoneId || ''),
        transactions: [...paymentTransactions, ...bonusTransactions].sort((a, b) => {
            const ad = a?.date ? new Date(a.date).getTime() : 0;
            const bd = b?.date ? new Date(b.date).getTime() : 0;
            return bd - ad;
        }),
        joiningBonusClaimed: false,
        joiningBonusAmount: 0
    };
};

// ----- Delivery partner earnings summary (Pocket / requests page) -----
export const getDeliveryPartnerEarnings = async (deliveryPartnerId, query = {}) => {
    if (!deliveryPartnerId || !mongoose.Types.ObjectId.isValid(deliveryPartnerId)) {
        throw new ValidationError('Delivery partner not found');
    }
    const period = String(query.period || 'week').toLowerCase();
    const date = query.date ? new Date(query.date) : new Date();
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 1000);

    const partnerId = new mongoose.Types.ObjectId(deliveryPartnerId);

    let range = null;
    if (period === 'today') {
        range = { start: toStartOfDay(date), end: toEndOfDay(date) };
    } else if (period === 'week') {
        range = getWeekRange(date);
    } else if (period === 'month') {
        range = getMonthRange(date);
    } else if (period === 'all') {
        range = null;
    } else {
        // fallback to week
        range = getWeekRange(date);
    }

    const match = {
        'dispatch.deliveryPartnerId': partnerId,
    };
    if (range) {
        match.orderStatus = { $in: PAYABLE_DELIVERY_STATUSES };
        match['deliveryState.deliveredAt'] = { $gte: range.start, $lte: range.end };
    } else {
        match.orderStatus = { $in: PAYABLE_DELIVERY_STATUSES };
    }

    const [totalOrders, agg] = await Promise.all([
        FoodOrder.countDocuments(match),
        FoodOrder.aggregate([
            { $match: match },
            {
                $group: {
                    _id: null,
                    totalEarnings: { $sum: { $ifNull: ['$riderEarning', 0] } }
                }
            }
        ])
    ]);

    const totalEarnings = Number(agg?.[0]?.totalEarnings) || 0;

    // Frontend only strongly relies on totalEarnings + totalOrders.
    const summary = {
        totalEarnings,
        totalOrders,
        totalHours: 0,
        totalMinutes: 0,
        orderEarning: totalEarnings,
        incentive: 0,
        otherEarnings: 0
    };

    return {
        summary,
        period,
        date: date.toISOString(),
        pagination: { page, limit, total: totalOrders }
    };
};

const normalizeStatusFilter = (status) => {
    if (!status) return null;
    const s = String(status || '').trim();
    if (!s || s.toUpperCase() === 'ALL TRIPS') return null;
    // UI uses Completed/Cancelled/Pending
    return s;
};

const toStartOfDay = (d) => {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
};

const toEndOfDay = (d) => {
    const x = new Date(d);
    x.setHours(23, 59, 59, 999);
    return x;
};

const getWeekRange = (anchorDate) => {
    const d = new Date(anchorDate);
    const start = toStartOfDay(d);
    start.setDate(start.getDate() - start.getDay()); // Sunday
    const end = toEndOfDay(start);
    end.setDate(start.getDate() + 6);
    return { start, end };
};

const getMonthRange = (anchorDate) => {
    const d = new Date(anchorDate);
    const start = new Date(d.getFullYear(), d.getMonth(), 1);
    start.setHours(0, 0, 0, 0);
    const end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    end.setHours(23, 59, 59, 999);
    return { start, end };
};

const computeRange = (period, date) => {
    const p = String(period || 'daily').toLowerCase();
    const anchor = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
    if (p === 'weekly' || p === 'week') return getWeekRange(anchor);
    if (p === 'monthly' || p === 'month') return getMonthRange(anchor);
    // daily
    return { start: toStartOfDay(anchor), end: toEndOfDay(anchor) };
};

const toTripDto = (order) => {
    const createdAt = order?.createdAt || null;
    const deliveredAt = order?.deliveryState?.deliveredAt || order?.deliveredAt || order?.completedAt || null;
    const orderStatus = String(order?.orderStatus || order?.status || '').toLowerCase();
    const dateForUi = deliveredAt || createdAt || order?.updatedAt || null;

    const time = dateForUi
        ? new Date(dateForUi).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
        : '';

    const isDelivered = orderStatus === 'delivered' || String(order?.deliveryState?.currentPhase || '').toLowerCase() === 'delivered';
    const isCancelled = orderStatus.startsWith('cancelled') || String(order?.deliveryState?.status || '').toLowerCase().includes('cancel');

    const status = isDelivered ? 'Completed' : isCancelled ? 'Cancelled' : 'Pending';

    const restaurantName =
        order?.restaurantId?.restaurantName ||
        order?.restaurantName ||
        order?.restaurant?.restaurantName ||
        '';

    const paymentMethod = order?.payment?.method || order?.paymentMethod || '';
    const pricingTotal = Number(order?.pricing?.total) || Number(order?.totalAmount) || 0;
    const isUserUnavailableCancelled =
        orderStatus === 'cancelled_by_user_unavailable' ||
        String(order?.cancelReasonType || order?.cancellationReasonType || '').toLowerCase() === 'user_unavailable';

    const rawEarningAmount = Number(order?.riderEarning ?? order?.deliveryEarning ?? 0) || 0;
    const earningAmount = (isDelivered || isUserUnavailableCancelled) ? rawEarningAmount : 0;
    const isCashOrder = paymentMethod === 'cash';
    const codAmount = isUserUnavailableCancelled
        ? 0
        : (isCashOrder ? Number(order?.payment?.amountDue) || 0 : 0);
    const codCollectedAmount =
        isUserUnavailableCancelled
            ? 0
            : (isCashOrder && order?.payment?.status === 'paid' ? codAmount : 0);
    return {
        id: order?._id,
        _id: order?._id,
        orderId: order?.orderId || order?._id,
        status,
        rawOrderStatus: orderStatus,
        isCompensatedCancellation: isUserUnavailableCancelled,
        restaurantName,
        restaurant: restaurantName,
        items: order?.items || order?.orderItems || [],
        orderItems: order?.orderItems || order?.items || [],
        paymentMethod,
        totalAmount: pricingTotal,
        orderTotal: pricingTotal,
        codExempt: isUserUnavailableCancelled,
        codAmount: codAmount,
        codCollectedAmount,
        deliveryEarning: earningAmount,
        earningAmount: earningAmount,
        amount: earningAmount, // legacy fallback
        createdAt: order?.createdAt,
        deliveredAt: deliveredAt,
        completedAt: deliveredAt,
        date: dateForUi,
        time
    };
};

export const getDeliveryPartnerTripHistory = async (deliveryPartnerId, query = {}) => {
    if (!deliveryPartnerId || !mongoose.Types.ObjectId.isValid(deliveryPartnerId)) {
        throw new ValidationError('Delivery partner not found');
    }
    const period = query.period || 'daily';
    const date = query.date ? new Date(query.date) : new Date();
    const statusFilter = normalizeStatusFilter(query.status);
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 1000);

    const { start, end } = computeRange(period, date);

    const partnerId = new mongoose.Types.ObjectId(deliveryPartnerId);
    const match = { 'dispatch.deliveryPartnerId': partnerId };

    const sf = String(statusFilter || '').toLowerCase();
    if (sf === 'completed') {
        match.orderStatus = { $in: PAYABLE_DELIVERY_STATUSES };
        match['deliveryState.deliveredAt'] = { $gte: start, $lte: end };
    } else if (sf === 'cancelled') {
        match.orderStatus = { $regex: '^cancelled', $options: 'i' };
        match.createdAt = { $gte: start, $lte: end };
    } else if (sf === 'pending') {
        match.createdAt = { $gte: start, $lte: end };
        // Pending = not delivered and not cancelled
        match.$and = [
            { orderStatus: { $ne: 'delivered' } },
            { orderStatus: { $not: { $regex: '^cancelled', $options: 'i' } } },
        ];
    } else {
        // ALL TRIPS: show anything created in range, and compute earnings only for delivered orders.
        match.createdAt = { $gte: start, $lte: end };
    }

    const orders = await FoodOrder.find(match)
        .populate({ path: 'restaurantId', select: 'restaurantName' })
        .sort({ 'deliveryState.deliveredAt': -1, createdAt: -1 })
        .limit(limit)
        .lean();

    const deliveredOrderIds = (orders || [])
        .filter((order) => PAYABLE_DELIVERY_STATUSES.includes(String(order?.orderStatus || '').toLowerCase()))
        .map((order) => order?._id)
        .filter((id) => mongoose.Types.ObjectId.isValid(String(id)))
        .map((id) => new mongoose.Types.ObjectId(String(id)));

    const settledOrderIdSet = new Set();
    if (deliveredOrderIds.length) {
        const settlementRows = await FoodPayoutSettlement.find({
            beneficiaryType: 'delivery',
            beneficiaryId: partnerId,
            status: 'paid',
            transactionIds: { $in: deliveredOrderIds }
        })
            .select('transactionIds')
            .lean();

        for (const row of settlementRows || []) {
            for (const txId of row?.transactionIds || []) {
                if (!txId) continue;
                settledOrderIdSet.add(String(txId));
            }
        }
    }

    const trips = (orders || []).map((order) => {
        const trip = toTripDto(order);
        const isDelivered = PAYABLE_DELIVERY_STATUSES.includes(String(order?.orderStatus || '').toLowerCase());
        const isPaid = isDelivered && settledOrderIdSet.has(String(order?._id));

        return {
            ...trip,
            partnerPayoutStatus: isPaid ? 'paid' : 'unpaid',
            payoutStatus: isPaid ? 'paid' : 'unpaid',
            settlementStatus: isPaid ? 'settled' : 'pending',
            paymentSettlementStatus: isPaid ? 'paid' : 'pending',
            deliveryPayoutStatus: isPaid ? 'paid' : 'unpaid',
            adminPayoutStatus: isPaid ? 'paid' : 'unpaid',
            isPartnerPaid: isPaid,
        };
    });

    return {
        period,
        date: (date || new Date()).toISOString(),
        range: { start: start.toISOString(), end: end.toISOString() },
        trips
    };
};

export const getDeliveryPartnerOrderQueue = async (deliveryPartnerId) => {
    if (!deliveryPartnerId || !mongoose.Types.ObjectId.isValid(deliveryPartnerId)) {
        throw new ValidationError('Delivery partner not found');
    }

    const partnerId = new mongoose.Types.ObjectId(deliveryPartnerId);
    const activeStatuses = [
        'confirmed',
        'preparing',
        'ready_for_pickup',
        'picked_up',
        'reached_pickup',
        'reached_drop'
    ];

    const docs = await FoodOrder.find({
        'dispatch.deliveryPartnerId': partnerId,
        orderStatus: { $in: activeStatuses },
        'dispatch.status': { $in: ['assigned', 'accepted'] }
    })
        .populate({ path: 'restaurantId', select: 'restaurantName name phone location addressLine1 area city state profileImage' })
        .populate({ path: 'userId', select: 'name phone' })
        .sort({ 'dispatch.acceptedAt': 1, 'dispatch.assignedAt': 1, createdAt: -1 })
        .lean();

    const decorated = (docs || []).map((doc) => {
        const sanitized = sanitizeOrderForExternal(doc);
        const dispatchStatus = String(sanitized?.dispatch?.status || '').toLowerCase();
        const queueStatus = dispatchStatus === 'accepted' ? 'accepted' : 'assigned';
        const phase = String(sanitized?.deliveryState?.currentPhase || '').toLowerCase();

        let queuePriority = 3;
        if (queueStatus === 'accepted') queuePriority = 2;
        if (queueStatus === 'accepted' && ['at_drop', 'picked_up', 'delivered', 'completed'].includes(phase)) {
            queuePriority = 1;
        }

        return {
            ...sanitized,
            queueStatus,
            queuePriority,
            isAdvancedOrder: true
        };
    });

    decorated.sort((a, b) => {
        const priorityDiff = Number(a?.queuePriority || 99) - Number(b?.queuePriority || 99);
        if (priorityDiff !== 0) return priorityDiff;

        const acceptedAtA = a?.dispatch?.acceptedAt ? new Date(a.dispatch.acceptedAt).getTime() : 0;
        const acceptedAtB = b?.dispatch?.acceptedAt ? new Date(b.dispatch.acceptedAt).getTime() : 0;
        if (acceptedAtA !== acceptedAtB) return acceptedAtA - acceptedAtB;

        const assignedAtA = a?.dispatch?.assignedAt ? new Date(a.dispatch.assignedAt).getTime() : 0;
        const assignedAtB = b?.dispatch?.assignedAt ? new Date(b.dispatch.assignedAt).getTime() : 0;
        return assignedAtA - assignedAtB;
    });

    const acceptedOrders = decorated.filter((item) => item.queueStatus === 'accepted');
    const assignedOrders = decorated.filter((item) => item.queueStatus === 'assigned');
    const currentOrder = acceptedOrders[0] || null;
    const queue = currentOrder
        ? decorated.filter((item) => String(item?._id || item?.orderId) !== String(currentOrder?._id || currentOrder?.orderId))
        : decorated;

    return {
        currentOrder,
        acceptedOrders,
        assignedOrders,
        queue,
        summary: {
            total: decorated.length,
            accepted: acceptedOrders.length,
            assigned: assignedOrders.length
        }
    };
};

export const getDeliveryPocketDetails = async (deliveryPartnerId, query = {}) => {
    if (!deliveryPartnerId || !mongoose.Types.ObjectId.isValid(deliveryPartnerId)) {
        throw new ValidationError('Delivery partner not found');
    }
    const date = query.date ? new Date(query.date) : new Date();
    const { start, end } = getWeekRange(date);
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 1000, 1), 2000);

    const partnerId = new mongoose.Types.ObjectId(deliveryPartnerId);

    const orders = await FoodOrder.find({
        'dispatch.deliveryPartnerId': partnerId,
        orderStatus: { $in: PAYABLE_DELIVERY_STATUSES },
        $or: [
            { 'deliveryState.deliveredAt': { $gte: start, $lte: end } },
            { deliveredAt: { $gte: start, $lte: end } },
            { completedAt: { $gte: start, $lte: end } },
            { updatedAt: { $gte: start, $lte: end } },
            { createdAt: { $gte: start, $lte: end } }
        ]
    })
        .populate({ path: 'restaurantId', select: 'restaurantName' })
        .sort({ 'deliveryState.deliveredAt': -1, deliveredAt: -1, completedAt: -1, updatedAt: -1, createdAt: -1 })
        .limit(limit)
        .lean();

    const bonusTxList = await DeliveryBonusTransaction.find({
        deliveryPartnerId: partnerId,
        createdAt: { $gte: start, $lte: end }
    })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();

    const trips = (orders || []).map(toTripDto);

    const paymentTransactions = (orders || []).map((o) => ({
        _id: o._id,
        type: 'payment',
        amount: Number(o.riderEarning) || 0,
        status: 'Completed',
        date: o?.deliveryState?.deliveredAt || o?.deliveredAt || o?.createdAt,
        createdAt: o?.deliveryState?.deliveredAt || o?.deliveredAt || o?.createdAt,
        orderId: o.orderId || String(o._id),
        metadata: { orderId: o.orderId || String(o._id) },
        description: o?.restaurantId?.restaurantName ? `Order earning - ${o.restaurantId.restaurantName}` : 'Order earning'
    }));

    const bonusTransactions = (bonusTxList || []).map((t) => ({
        _id: t._id,
        type: 'bonus',
        amount: Number(t.amount) || 0,
        status: 'Completed',
        date: t.createdAt,
        createdAt: t.createdAt,
        metadata: { reference: t.reference || '' },
        description: t.reference ? `Bonus - ${t.reference}` : 'Bonus'
    }));

    const totalEarning = paymentTransactions.reduce((sum, t) => sum + (Number(t.amount) || 0), 0);
    const totalBonus = bonusTransactions.reduce((sum, t) => sum + (Number(t.amount) || 0), 0);

    return {
        week: { start: start.toISOString(), end: end.toISOString() },
        summary: { totalEarning, totalBonus, grandTotal: totalEarning + totalBonus },
        trips,
        transactions: {
            payment: paymentTransactions,
            bonus: bonusTransactions
        }
    };
};

export const getActiveEarningAddonsForPartner = async (deliveryPartnerId) => {
    if (!deliveryPartnerId || !mongoose.Types.ObjectId.isValid(deliveryPartnerId)) {
        throw new ValidationError('Delivery partner not found');
    }

    const partnerId = new mongoose.Types.ObjectId(deliveryPartnerId);
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const endOfToday = new Date(now);
    endOfToday.setHours(23, 59, 59, 999);

    const addons = await FoodEarningAddon.find({
        status: 'active',
        startDate: { $lte: endOfToday },
        endDate: { $gte: todayStart }
    })
        .sort({ endDate: 1, createdAt: 1 })
        .lean();

    const liveAddons = (addons || []).filter((addon) => {
        if (!addon) return false;
        if (addon.startDate && now < new Date(addon.startDate)) return false;
        if (addon.endDate) {
            const expiry = new Date(addon.endDate);
            expiry.setHours(23, 59, 59, 999);
            if (now > expiry) return false;
        }
        const maxRedemptions = Number(addon.maxRedemptions);
        if (!Number.isFinite(maxRedemptions) || maxRedemptions <= 0) return true;
        return Number(addon.currentRedemptions || 0) < maxRedemptions;
    });

    const offers = await Promise.all(
        liveAddons.map(async (addon) => {
            const startDate = addon.startDate ? new Date(addon.startDate) : null;
            const endDate = addon.endDate ? new Date(addon.endDate) : null;

            const baseMatch = {
                'dispatch.deliveryPartnerId': partnerId,
                orderStatus: { $in: PAYABLE_DELIVERY_STATUSES }
            };

            if (startDate && endDate) {
                baseMatch['deliveryState.deliveredAt'] = { $gte: startDate, $lte: endDate };
            }

            const [currentOrders, earningsAgg] = await Promise.all([
                FoodOrder.countDocuments(baseMatch),
                FoodOrder.aggregate([
                    { $match: baseMatch },
                    {
                        $group: {
                            _id: null,
                            total: { $sum: { $ifNull: ['$riderEarning', 0] } }
                        }
                    }
                ])
            ]);

            const currentEarnings = Number(earningsAgg?.[0]?.total) || 0;

            return {
                id: addon._id,
                title: addon.title || 'Earnings Guarantee',
                description: addon.description || '',
                targetAmount: Number(addon.earningAmount) || 0,
                targetOrders: Number(addon.requiredOrders) || 0,
                currentOrders: Number(currentOrders) || 0,
                currentEarnings,
                startDate,
                endDate,
                validTill: endDate ? endDate.toISOString() : null,
                isLive: true
            };
        })
    );

    return {
        activeOffer: offers[0] || null,
        offers
    };
};
