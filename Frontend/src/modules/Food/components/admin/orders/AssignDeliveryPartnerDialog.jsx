import { useEffect, useState } from "react"
import { Loader2, MapPin, Phone, Truck } from "lucide-react"
import { adminAPI } from "@food/api"
import { toast } from "sonner"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

const normalizeId = (value) => {
  if (!value) return ""
  if (typeof value === "string") return value.trim()
  if (typeof value === "number") return String(value)
  if (typeof value === "object") {
    if (value?._id) return normalizeId(value._id)
    if (value?.$oid) return String(value.$oid).trim()
    if (typeof value.toString === "function") {
      const raw = String(value.toString()).trim()
      if (raw && raw !== "[object Object]") return raw
    }
  }
  return ""
}

const isPartnerOnline = (partner) => {
  const state = String(partner?.availabilityStatus || "").toLowerCase()
  if (state === "online") return true
  if (partner?.availability?.isOnline === true || partner?.isOnline === true) return true
  const lastAt = partner?.lastLocationAt || partner?.availability?.lastLocationUpdate
  if (lastAt && (Date.now() - new Date(lastAt).getTime()) <= 15 * 60 * 1000) return true
  if (state === "offline") return false
  if (partner?.availability?.isOnline === true) return true
  if (partner?.availability?.isOnline === false) return false
  return Boolean(partner?.isOnline)
}

const getPartnerZoneId = (partner) =>
  normalizeId(partner?.zoneId?._id) ||
  normalizeId(partner?.zoneId) ||
  normalizeId(partner?.zone?._id) ||
  normalizeId(partner?.zone)

const getOrderRestaurantZoneId = (order) =>
  normalizeId(order?.originalOrder?.restaurantId?.zoneId?._id) ||
  normalizeId(order?.originalOrder?.restaurantId?.zoneId) ||
  normalizeId(order?.restaurantZoneId)

const getOrderUserZoneId = (order) =>
  normalizeId(order?.originalOrder?.userId?.zoneId?._id) ||
  normalizeId(order?.originalOrder?.userId?.zoneId) ||
  normalizeId(order?.originalOrder?.deliveryAddress?.zoneId?._id) ||
  normalizeId(order?.originalOrder?.deliveryAddress?.zoneId) ||
  normalizeId(order?.userZoneId)

const getOrderPaymentMethod = (order) =>
  String(
    order?.originalOrder?.payment?.method ||
    order?.payment?.method ||
    order?.paymentMethod ||
    "",
  ).trim().toLowerCase()

const getOrderCodAmount = (order) =>
  Math.max(
    0,
    Number(
      order?.originalOrder?.pricing?.total ??
      order?.originalOrder?.totalAmount ??
      order?.originalOrder?.grandTotal ??
      order?.pricing?.total ??
      order?.totalAmount ??
      0,
    ) || 0,
  )

const isCodOrder = (order) =>
  ["cash", "cod", "cash_on_delivery", "razorpay_qr"].includes(getOrderPaymentMethod(order))

export default function AssignDeliveryPartnerDialog({
  isOpen,
  onOpenChange,
  order,
  onAssigned,
}) {
  const [deliveryPartners, setDeliveryPartners] = useState([])
  const [blockedByCashLimitCount, setBlockedByCashLimitCount] = useState(0)
  const [isLoading, setIsLoading] = useState(false)
  const [selectedPartnerId, setSelectedPartnerId] = useState("")
  const [isAssigning, setIsAssigning] = useState(false)

  const orderZoneId =
    normalizeId(order?.zoneId) ||
    normalizeId(order?.originalOrder?.zoneId?._id) ||
    normalizeId(order?.originalOrder?.zoneId) ||
    normalizeId(order?.originalOrder?.restaurantId?.zoneId?._id) ||
    normalizeId(order?.originalOrder?.restaurantId?.zoneId)
  const restaurantZoneId = getOrderRestaurantZoneId(order)
  const userZoneId = getOrderUserZoneId(order)
  const hasZoneMismatch = Boolean(restaurantZoneId && userZoneId && restaurantZoneId !== userZoneId)
  const resolvedZoneId = restaurantZoneId || userZoneId || orderZoneId
  const orderIsCod = isCodOrder(order)
  const orderCodAmount = orderIsCod ? getOrderCodAmount(order) : 0

  useEffect(() => {
    if (!isOpen) {
      setDeliveryPartners([])
      setBlockedByCashLimitCount(0)
      setSelectedPartnerId("")
      setIsLoading(false)
      setIsAssigning(false)
      return
    }

    if (!resolvedZoneId || hasZoneMismatch) {
      setDeliveryPartners([])
      setBlockedByCashLimitCount(0)
      return
    }

    const loadPartners = async () => {
      try {
        setIsLoading(true)
        const response = await adminAPI.getDeliveryPartners({
          page: 1,
          limit: 1000,
          zoneId: resolvedZoneId,
          includeAvailability: true,
          status: 'approved',
        })

        const zoneScopedList = response?.data?.data?.deliveryPartners || []
        const strictZonePartners = zoneScopedList.filter(
          (partner) => getPartnerZoneId(partner) === resolvedZoneId && partner.status === 'approved',
        )
        const strictOnlineZonePartners = strictZonePartners.filter((partner) =>
          isPartnerOnline(partner),
        )
        const wouldExceedCashLimit = (partner) => {
          if (!orderIsCod) return false
          const currentCashInHand = Math.max(0, Number(partner?.cashInHand) || 0)
          const effectiveCashLimit = Math.max(0, Number(partner?.effectiveCashLimit) || 0)
          const projectedCashInHand = currentCashInHand + orderCodAmount

          return effectiveCashLimit <= 0
            ? projectedCashInHand > 0
            : projectedCashInHand >= effectiveCashLimit
        }
        const cashEligiblePartners = strictOnlineZonePartners.filter(
          (partner) => !wouldExceedCashLimit(partner),
        )
        setBlockedByCashLimitCount(strictOnlineZonePartners.length - cashEligiblePartners.length)
        setDeliveryPartners(cashEligiblePartners)
      } catch (error) {
        toast.error(error?.response?.data?.message || "Failed to load delivery partners")
        setDeliveryPartners([])
        setBlockedByCashLimitCount(0)
      } finally {
        setIsLoading(false)
      }
    }

    loadPartners()
  }, [isOpen, resolvedZoneId, hasZoneMismatch, orderCodAmount, orderIsCod])

  const handleAssign = async () => {
    if (!order?.orderMongoId || !selectedPartnerId) return

    try {
      setIsAssigning(true)
      await adminAPI.assignDeliveryPartner(order.orderMongoId, selectedPartnerId)
      toast.success("Delivery request sent. Waiting for delivery boy acceptance")
      onAssigned?.()
      onOpenChange(false)
    } catch (error) {
      toast.error(error?.response?.data?.message || "Failed to assign delivery partner")
    } finally {
      setIsAssigning(false)
    }
  }

  const sortedPartners = [...deliveryPartners]

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl !p-0 overflow-hidden">
        <DialogHeader className="px-6 pt-6">
          <DialogTitle>Assign Delivery Partner</DialogTitle>
          <DialogDescription>
            {order?.orderId
              ? `Choose a delivery partner for order #${order.orderId}.`
              : "Choose a delivery partner."}
          </DialogDescription>
        </DialogHeader>

        <div className="px-6 py-4">
          {hasZoneMismatch ? (
            <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-5 text-sm text-red-800">
              Restaurant zone and user zone are different for this order. Please keep both in same zone before assigning delivery partner.
            </div>
          ) : !resolvedZoneId ? (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-5 text-sm text-amber-800">
              This order does not have a zone assigned yet, so same-zone delivery partners cannot be listed.
            </div>
          ) : isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-orange-500" />
            </div>
          ) : sortedPartners.length === 0 ? (
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-5 text-sm text-slate-600">
              {blockedByCashLimitCount > 0
                ? orderIsCod
                  ? "All online delivery partners in this zone would cross their cash-in-hand limit with this COD order."
                  : "All online delivery partners in this zone have reached their cash-in-hand limit."
                : "No online delivery partners were found in this zone."}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                Showing <span className="font-semibold text-slate-800">{sortedPartners.length}</span> online partners in this zone
                {blockedByCashLimitCount > 0 ? ` (${blockedByCashLimitCount} hidden due to cash limit)` : ""}
              </div>
              <div className="max-h-[380px] space-y-3 overflow-y-auto pr-1">
                {sortedPartners.map((partner) => {
                  const isSelected = selectedPartnerId === String(partner._id)
                  const isOnline = isPartnerOnline(partner)
                  return (
                    <button
                      key={partner._id}
                      type="button"
                      onClick={() => setSelectedPartnerId(String(partner._id))}
                      className={`w-full rounded-2xl border px-4 py-4 text-left transition ${
                        isSelected
                          ? "border-orange-400 bg-orange-50 shadow-sm"
                          : "border-slate-200 bg-white hover:border-orange-200 hover:bg-slate-50"
                      }`}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold text-slate-900">{partner.name || "Unnamed Partner"}</p>
                          <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-600">
                            <span className="inline-flex items-center gap-1">
                              <Phone className="h-3.5 w-3.5" />
                              {partner.phone || "N/A"}
                            </span>
                            <span className="inline-flex items-center gap-1">
                              <MapPin className="h-3.5 w-3.5" />
                              {partner.zone || "Zone not set"}
                            </span>
                            <span className="inline-flex items-center gap-1">
                              <Truck className="h-3.5 w-3.5" />
                              <span
                                className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${
                                  isOnline
                                    ? "bg-emerald-100 text-emerald-700"
                                    : "bg-slate-100 text-slate-600"
                                }`}
                              >
                                {isOnline ? "Online" : "Offline"}
                              </span>
                            </span>
                          </div>
                        </div>
                        <span
                          className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${
                            isSelected
                              ? "bg-orange-500 text-white"
                              : "bg-slate-100 text-slate-700"
                          }`}
                        >
                          {isSelected ? "Selected" : "Select"}
                        </span>
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="px-6 pb-6 pt-2">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleAssign}
            disabled={!selectedPartnerId || isAssigning || !resolvedZoneId || hasZoneMismatch}
            className="rounded-xl bg-orange-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isAssigning ? "Assigning..." : "Assign Partner"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
