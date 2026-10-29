/**
 * Central API client for backend (auth and future APIs).
 * - baseURL from VITE_API_BASE_URL (e.g. http://localhost:5000/api/v1)
 * - When baseURL ends with /api/v1, request paths must NOT include /v1 (use /food/..., /auth/...)
 * - Attaches Bearer token (user or admin based on request URL)
 * - On 401: attempts refresh, retries once; on refresh failure logs out
 */

import axios from "axios";

// Prefer explicit env. If not set, use same-origin (works with a Vite proxy).
// This avoids hardcoding ports like 5000 that may conflict with local setups.
const baseURL =
  typeof import.meta !== "undefined" && import.meta.env?.VITE_API_BASE_URL
    ? String(import.meta.env.VITE_API_BASE_URL).replace(/\/$/, "")
    : "";

const apiClient = axios.create({
  baseURL: baseURL || undefined,
  timeout: 30000,
  headers: { "Content-Type": "application/json" },
});

function getModuleFromUrl(url = "") {
  const u = typeof url === "string" ? url : (url?.url || "");
  if (!u) return "user";
  
  const normalized = u.toLowerCase();
  
  // Admin detection
  if (
    normalized.includes("/admin/") || 
    normalized.includes("/food/admin/") || 
    normalized.includes("/food/auth/admin") || 
    normalized.includes("/auth/admin") || 
    normalized.includes("admin/login")
  ) return "admin";
  
  // Delivery detection - Catch all delivery-specific functional and auth routes
  if (
    normalized.includes("/food/delivery") || 
    normalized.includes("/auth/delivery") || 
    normalized.includes("/delivery/")
  ) return "delivery";
  
  // Restaurant detection - Catch all restaurant-specific functional and auth routes
  if (
    normalized.includes("/food/restaurant/") || 
    normalized.includes("/auth/restaurant") || 
    normalized.includes("/restaurant/")
  ) {
    // Exception: /food/restaurants (plural) is usually a public user app route
    if (normalized.includes("/food/restaurants") && !normalized.includes("/food/restaurant/")) {
       return "user";
    }
    return "restaurant";
  }
  
  return "user";
}

function getModuleFromPagePath() {
  if (typeof window === "undefined") return null;
  const path = window.location.pathname.toLowerCase();
  if (path.startsWith("/admin")) return "admin";
  if (path.startsWith("/food/restaurant") || path.startsWith("/restaurant")) return "restaurant";
  if (path.startsWith("/food/delivery") || path.startsWith("/delivery")) return "delivery";
  return null;
}

function getModuleFromConfig(config) {
  if (config?.contextModule) return config.contextModule;
  const pageModule = getModuleFromPagePath();
  const urlModule = getModuleFromUrl(config?.url);
  if (pageModule && (urlModule === "user" || !urlModule)) {
    return pageModule;
  }
  return urlModule;
}

function getAccessToken(config) {
  const module = getModuleFromConfig(config);
  try {
    if (module === "admin") {
      return (
        localStorage.getItem("admin_accessToken") ||
        localStorage.getItem("auth_admin") ||
        null
      );
    }
    if (module === "restaurant" || module === "seller") {
      return (
        localStorage.getItem("restaurant_accessToken") ||
        localStorage.getItem("seller_accessToken") ||
        localStorage.getItem("auth_seller") ||
        localStorage.getItem("accessToken") ||
        null
      );
    }
    if (module === "delivery") {
      return (
        localStorage.getItem("delivery_accessToken") ||
        localStorage.getItem("auth_delivery") ||
        localStorage.getItem("accessToken") ||
        null
      );
    }
    return (
      localStorage.getItem("user_accessToken") ||
      localStorage.getItem("auth_customer") ||
      localStorage.getItem("accessToken") ||
      null
    );
  } catch {
    return null;
  }
}

function getRefreshToken(module) {
  try {
    if (module === "admin") {
      return (
        localStorage.getItem("admin_refreshToken") ||
        localStorage.getItem("refreshToken") ||
        null
      );
    }
    if (module === "restaurant" || module === "seller") {
      return (
        localStorage.getItem("restaurant_refreshToken") ||
        localStorage.getItem("seller_refreshToken") ||
        localStorage.getItem("refreshToken") ||
        null
      );
    }
    if (module === "delivery") {
      return (
        localStorage.getItem("delivery_refreshToken") ||
        localStorage.getItem("refreshToken") ||
        null
      );
    }
    return (
      localStorage.getItem("user_refreshToken") ||
      localStorage.getItem("refreshToken") ||
      null
    );
  } catch {
    return null;
  }
}

function clearModuleAuth(module) {
  try {
    localStorage.removeItem(`${module}_accessToken`);
    localStorage.removeItem(`${module}_refreshToken`);
    localStorage.removeItem(`${module}_authenticated`);
    localStorage.removeItem(`${module}_user`);
    if (module === "admin") {
      localStorage.removeItem("auth_admin");
      localStorage.removeItem("admin_sidebar_state");
      localStorage.removeItem("admin_recent_searches");
      try {
        sessionStorage.removeItem("adminAuthData");
      } catch (_) {}
    }
    if (module === "restaurant" || module === "seller") {
      localStorage.removeItem("auth_seller");
      localStorage.removeItem("seller_accessToken");
      localStorage.removeItem("seller_refreshToken");
    }
    if (module === "delivery") {
      localStorage.removeItem("auth_delivery");
    }
    if (module === "user") {
      localStorage.removeItem("userProfile");
      localStorage.removeItem("user_user");
      localStorage.removeItem("auth_customer");
      localStorage.removeItem("accessToken");
    }
  } catch (_) {}
}

let isRefreshing = false;
let refreshSubscribers = [];

function subscribeToRefresh(cb) {
  refreshSubscribers.push(cb);
}

function onRefreshed(newToken, module) {
  refreshSubscribers.forEach((cb) => cb(newToken, module));
  refreshSubscribers = [];
}

function onRefreshFailed(module) {
  clearModuleAuth(module);
  // Fail any queued requests that were waiting for this refresh
  refreshSubscribers.forEach((cb) => cb(null, module));
  refreshSubscribers = [];
  
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("authRefreshFailed", { detail: { module } }));
    if (module === "admin") {
      window.dispatchEvent(new Event("adminAuthChanged"));
    }

    const currentPath = window.location.pathname.toLowerCase();
    const isAdminRoute = currentPath === "/admin" || currentPath.startsWith("/admin/");
    const isLoginRoute = currentPath === "/admin/login" || currentPath === "/admin/auth" || currentPath.startsWith("/admin/forgot-password");

    if ((module === "admin" || isAdminRoute) && !isLoginRoute) {
      window.location.replace("/admin/login?expired=1");
      return;
    }

    if ((module === "restaurant" || module === "seller") && !currentPath.startsWith("/restaurant/auth") && !currentPath.startsWith("/seller/auth")) {
      window.location.replace("/seller/auth?expired=1");
    } else if (module === "delivery" && !currentPath.startsWith("/delivery/auth")) {
      window.location.replace("/delivery/auth?expired=1");
    } else if (module === "user" && !currentPath.startsWith("/login") && !currentPath.startsWith("/user/auth")) {
      window.location.replace("/login?expired=1");
    }
  }
}

apiClient.interceptors.request.use(
  (config) => {
    config.contextModule = getModuleFromConfig(config);

    // If sending FormData, let the browser set proper multipart boundary.
    if (config.data instanceof FormData) {
      if (config.headers && config.headers["Content-Type"]) {
        delete config.headers["Content-Type"];
      }
    }

    const token = getAccessToken(config);
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (err) => Promise.reject(err)
);

apiClient.interceptors.response.use(
  (response) => response,
  async (err) => {
    const original = err?.config;
    if (err?.response?.status === 429) {
      return Promise.reject(err);
    }
    if (err?.response?.status !== 401 || !original) {
      return Promise.reject(err);
    }
    const module = original.contextModule || getModuleFromConfig(original) || getModuleFromUrl(original.url);
    if (original._retry) {
      onRefreshFailed(module);
      return Promise.reject(err);
    }
    const refreshToken = getRefreshToken(module);
    if (!refreshToken) {
      onRefreshFailed(module);
      return Promise.reject(err);
    }

    if (isRefreshing) {
      return new Promise((resolve, reject) => {
        subscribeToRefresh((newToken) => {
          if (newToken) {
            original.headers.Authorization = `Bearer ${newToken}`;
            resolve(apiClient(original));
          } else {
            reject(err);
          }
        });
      });
    }

    original._retry = true;
    isRefreshing = true;

    try {
      // Use relative URL so this works both with an explicit baseURL and with a dev proxy.
      // Use plain axios to avoid interceptor recursion.
      const refreshUrl = baseURL ? `${baseURL}/food/auth/refresh-token` : "/api/v1/food/auth/refresh-token";
      const { data } = await axios.post(refreshUrl, { refreshToken }, { timeout: 10000 });
      const newAccessToken = data?.data?.accessToken || data?.accessToken;
      if (newAccessToken) {
        try {
          localStorage.setItem(`${module}_accessToken`, newAccessToken);
          if (module === "admin") {
            localStorage.setItem("auth_admin", newAccessToken);
          }
          if (module === "restaurant") {
            localStorage.setItem("auth_seller", newAccessToken);
            localStorage.setItem("seller_accessToken", newAccessToken);
          }
          if (module === "delivery") {
            localStorage.setItem("auth_delivery", newAccessToken);
          }
          if (module === "user") {
            localStorage.setItem("auth_customer", newAccessToken);
            localStorage.setItem("accessToken", newAccessToken);
          }
          // Dispatch a custom event specifically for the module that refreshed
          window.dispatchEvent(new CustomEvent("authRefreshed", { 
            detail: { module, token: newAccessToken } 
          }));
        } catch (_) {}
        onRefreshed(newAccessToken, module);
        original.headers.Authorization = `Bearer ${newAccessToken}`;
        return apiClient(original);
      }
    } catch (_) {
      onRefreshFailed(module);
      return Promise.reject(err);
    } finally {
      isRefreshing = false;
    }

    onRefreshFailed(module);
    return Promise.reject(err);
  }
);

export default apiClient;
