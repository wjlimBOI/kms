/**
 * CSRF Token Management - Shared Utility
 */

let csrfToken = null;
let csrfFetchPromise = null;
let tokenRefreshInProgress = false;

/**
 * Fetch a new CSRF token from the server
 */
async function fetchCsrfToken() {
    if (csrfFetchPromise) {
        return csrfFetchPromise;
    }

    csrfFetchPromise = (async () => {
        try {
            const response = await fetch('/api/csrf-token', {
                credentials: 'include',
                headers: { 'Accept': 'application/json' }
            });
            if (response.ok) {
                const data = await response.json();
                csrfToken = data.csrfToken;
                const meta = document.querySelector('meta[name="csrf-token"]');
                if (meta) meta.setAttribute('content', csrfToken);
                return csrfToken;
            }
            console.error('[CSRF] Failed to fetch token:', response.status);
            return null;
        } catch (error) {
            console.error('[CSRF] Fetch error:', error);
            return null;
        } finally {
            csrfFetchPromise = null;
        }
    })();

    return csrfFetchPromise;
}

/**
 * Get the current CSRF token, fetching a new one if not available
 */
async function getCsrfToken() {
    if (csrfToken) return csrfToken;
    return await fetchCsrfToken();
}

/**
 * Refresh the CSRF token (clear cache and fetch new)
 */
async function refreshCsrfToken() {
    if (tokenRefreshInProgress) {
        return await csrfFetchPromise;
    }
    tokenRefreshInProgress = true;
    try {
        csrfToken = null;
        csrfFetchPromise = null;
        return await fetchCsrfToken();
    } finally {
        tokenRefreshInProgress = false;
    }
}

/**
 * Clear the cached CSRF token
 */
function clearCsrfToken() {
    csrfToken = null;
    csrfFetchPromise = null;
    tokenRefreshInProgress = false;
}

/**
 * Get CSRF token and update the meta tag
 */
async function ensureCsrfToken() {
    const token = await getCsrfToken();
    const meta = document.querySelector('meta[name="csrf-token"]');
    if (meta && token) {
        meta.setAttribute('content', token);
    }
    return token;
}

/**
 * Get headers object with CSRF token included
 */
async function getCsrfHeaders(additionalHeaders = {}) {
    const token = await getCsrfToken();
    return {
        'X-CSRF-Token': token || '',
        'X-Requested-With': 'XMLHttpRequest',
        ...additionalHeaders
    };
}

/**
 * Check if CSRF token is available
 */
function hasCsrfToken() {
    return !!csrfToken;
}

// Export for use in other files
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        fetchCsrfToken,
        getCsrfToken,
        refreshCsrfToken,
        clearCsrfToken,
        ensureCsrfToken,
        getCsrfHeaders,
        hasCsrfToken
    };
}