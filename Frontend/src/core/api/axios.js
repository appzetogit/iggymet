import axios from 'axios';

const axiosInstance = axios.create({
    baseURL: import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000/api/v1',
    headers: {
        'Content-Type': 'application/json',
    },
});

const getCustomerToken = () =>
    localStorage.getItem('auth_customer') ||
    localStorage.getItem('user_accessToken') ||
    localStorage.getItem('accessToken') ||
    null;

const getAdminToken = () =>
    localStorage.getItem('auth_admin') ||
    localStorage.getItem('admin_accessToken') ||
    null;

const getSellerToken = () =>
    localStorage.getItem('auth_seller') ||
    localStorage.getItem('seller_accessToken') ||
    localStorage.getItem('restaurant_accessToken') ||
    null;

const getDeliveryToken = () =>
    localStorage.getItem('auth_delivery') ||
    localStorage.getItem('delivery_accessToken') ||
    null;

// Request interceptor for API calls
axiosInstance.interceptors.request.use(
    (config) => {
        let token = null;
        const url = config.url || '';
        const pagePath = typeof window !== 'undefined' ? window.location.pathname : '';

        // Determination strategy: 
        // 1. If we are on a module-specific page (e.g. /seller/dashboard), prioritize that module's token
        // This is crucial for shared APIs like /products or /admin/categories
        if (pagePath.startsWith('/seller') || pagePath.startsWith('/restaurant')) {
            token = getSellerToken();
        } else if (pagePath.startsWith('/admin')) {
            token = getAdminToken();
        } else if (pagePath.startsWith('/delivery')) {
            token = getDeliveryToken();
        } else if (pagePath.startsWith('/customer')) {
            token = getCustomerToken();
        }

        // 2. Fallback to URL-based detection
        if (!token) {
            if (url.startsWith('/seller') || url.startsWith('/restaurant')) token = getSellerToken();
            else if (url.startsWith('/admin') || url.startsWith('/food/admin')) token = getAdminToken();
            else if (url.startsWith('/delivery') || url.startsWith('/food/delivery')) token = getDeliveryToken();
            else if (url.startsWith('/customer') || url.startsWith('/cart') || url.startsWith('/wishlist') || url.startsWith('/categories') || url.startsWith('/products')) {
                token = getCustomerToken();
            }
        }

        // 3. Final default: if we are on a general page and STILL no token, try customer token
        if (!token && !pagePath.startsWith('/admin') && !pagePath.startsWith('/seller') && !pagePath.startsWith('/restaurant') && !pagePath.startsWith('/delivery')) {
            token = getCustomerToken();
        }

        // 3. Last fallback: Check common 'token' key if implemented
        if (!token) {
            token = localStorage.getItem('token');
        }

        if (token) {
            config.headers.Authorization = `Bearer ${token}`;
        }
        return config;
    },
    (error) => {
        return Promise.reject(error);
    }
);

let isRefreshing = false;
let refreshSubscribers = [];

const subscribeToRefresh = (cb) => {
    refreshSubscribers.push(cb);
};

const onRefreshed = (newToken) => {
    refreshSubscribers.forEach((cb) => cb(newToken));
    refreshSubscribers = [];
};

const getRefreshTokenForModule = (module) => {
    if (module === 'seller') {
        return localStorage.getItem('restaurant_refreshToken') || localStorage.getItem('seller_refreshToken') || localStorage.getItem('refreshToken');
    }
    if (module === 'delivery') {
        return localStorage.getItem('delivery_refreshToken') || localStorage.getItem('refreshToken');
    }
    if (module === 'admin') {
        return localStorage.getItem('admin_refreshToken') || localStorage.getItem('refreshToken');
    }
    return localStorage.getItem('user_refreshToken') || localStorage.getItem('refreshToken');
};

const setNewAccessTokenForModule = (module, token) => {
    if (module === 'seller') {
        localStorage.setItem('auth_seller', token);
        localStorage.setItem('seller_accessToken', token);
        localStorage.setItem('restaurant_accessToken', token);
    } else if (module === 'delivery') {
        localStorage.setItem('auth_delivery', token);
        localStorage.setItem('delivery_accessToken', token);
    } else if (module === 'admin') {
        localStorage.setItem('auth_admin', token);
        localStorage.setItem('admin_accessToken', token);
    } else {
        localStorage.setItem('auth_customer', token);
        localStorage.setItem('user_accessToken', token);
        localStorage.setItem('accessToken', token);
    }
};

const onRefreshFailed = (module) => {
    refreshSubscribers.forEach((cb) => cb(null));
    refreshSubscribers = [];

    const moduleStorageKeys = {
        seller: ['auth_seller', 'seller_accessToken', 'restaurant_accessToken', 'restaurant_refreshToken', 'seller_refreshToken', 'token'],
        admin: ['auth_admin', 'admin_accessToken', 'admin_refreshToken', 'token'],
        delivery: ['auth_delivery', 'delivery_accessToken', 'delivery_refreshToken', 'token'],
        customer: ['auth_customer', 'user_accessToken', 'accessToken', 'user_refreshToken', 'token'],
    };
    const keysToClear = moduleStorageKeys[module] || ['token'];
    keysToClear.forEach((key) => localStorage.removeItem(key));

    if (module === 'seller') window.location.href = '/seller/auth';
    else if (module === 'admin') window.location.href = '/admin/login';
    else if (module === 'delivery') window.location.href = '/delivery/auth';
    else window.location.href = '/login';
};

// Response interceptor for API calls
axiosInstance.interceptors.response.use(
    (response) => response,
    async (error) => {
        const originalRequest = error.config;
        if (error.response?.status === 401 && !originalRequest._retry) {
            originalRequest._retry = true;

            const path = window.location.pathname;
            const currentModule = path.startsWith('/seller')
                ? 'seller'
                : path.startsWith('/admin')
                    ? 'admin'
                    : path.startsWith('/delivery')
                        ? 'delivery'
                        : 'customer';

            const refreshToken = getRefreshTokenForModule(currentModule);
            if (!refreshToken) {
                onRefreshFailed(currentModule);
                return Promise.reject(error);
            }

            if (isRefreshing) {
                return new Promise((resolve, reject) => {
                    subscribeToRefresh((newToken) => {
                        if (newToken) {
                            originalRequest.headers.Authorization = `Bearer ${newToken}`;
                            resolve(axiosInstance(originalRequest));
                        } else {
                            reject(error);
                        }
                    });
                });
            }

            isRefreshing = true;

            try {
                const baseURL = axiosInstance.defaults.baseURL || '';
                const refreshUrl = baseURL ? `${baseURL.replace(/\/$/, '')}/food/auth/refresh-token` : '/api/v1/food/auth/refresh-token';
                const { data } = await axios.post(refreshUrl, { refreshToken }, { timeout: 10000 });
                const newAccessToken = data?.data?.accessToken || data?.accessToken;

                if (newAccessToken) {
                    setNewAccessTokenForModule(currentModule, newAccessToken);
                    onRefreshed(newAccessToken);
                    originalRequest.headers.Authorization = `Bearer ${newAccessToken}`;
                    return axiosInstance(originalRequest);
                }
            } catch (refreshErr) {
                onRefreshFailed(currentModule);
                return Promise.reject(refreshErr);
            } finally {
                isRefreshing = false;
            }

            onRefreshFailed(currentModule);
            return Promise.reject(error);
        }
        return Promise.reject(error);
    }
);

export default axiosInstance;
