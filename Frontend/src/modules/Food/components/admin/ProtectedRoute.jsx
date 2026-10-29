import { Navigate, useLocation } from "react-router-dom"
import { isModuleAuthenticated, clearModuleAuth } from "@food/utils/auth"

const normalizePath = (value = "") => {
  const raw = String(value || "").trim()
  if (!raw) return "/"
  const cleaned = raw.replace(/\/+$/, "")
  return cleaned || "/"
}

const hasPathAccess = (permissions = [], path = "") => {
  const target = normalizePath(path)
  return permissions.some((permissionPath) => {
    const normalizedPermission = normalizePath(permissionPath)
    return (
      target === normalizedPermission ||
      target.startsWith(`${normalizedPermission}/`) ||
      normalizedPermission.startsWith(`${target}/`)
    )
  })
}

export default function ProtectedRoute({ children }) {
  const location = useLocation()
  const isAuthenticated = isModuleAuthenticated("admin")

  if (!isAuthenticated) {
    clearModuleAuth("admin");
    return <Navigate to="/admin/login?expired=1" state={{ from: location.pathname, expired: true }} replace />
  }

  try {
    const raw = localStorage.getItem("admin_user")
    const adminUser = raw ? JSON.parse(raw) : null
    const adminType = String(adminUser?.adminType || "SUPER_ADMIN").toUpperCase()
    const isSubAdmin = adminType === "SUB_ADMIN"
    const permissions = Array.isArray(adminUser?.permissions) ? adminUser.permissions : []
    if (isSubAdmin) {
      const currentPath = normalizePath(location.pathname)
      const canAccess = hasPathAccess(permissions, currentPath)
      if (!canAccess) {
        const fallback = permissions.length > 0 ? normalizePath(permissions[0]) : "/admin/food"
        if (fallback !== currentPath) {
          return <Navigate to={fallback} replace />
        }
      }
    }
  } catch {
    // no-op
  }

  return children
}
