(function() {
    'use strict';
    
    // Function to completely clear all client-side data
    function forceClearAll() {
        // Clear localStorage
        try {
            localStorage.clear();
        } catch(e) {
            console.warn('localStorage clear failed:', e);
        }
        
        // Clear sessionStorage
        try {
            sessionStorage.clear();
        } catch(e) {
            console.warn('sessionStorage clear failed:', e);
        }
        
        // Clear all cookies
        try {
            document.cookie.split(";").forEach(function(c) {
                // Clear with path=/
                document.cookie = c.replace(/^ +/, "")
                    .replace(/=.*/, "=;expires=" + new Date().toUTCString() + ";path=/");
                // Clear with domain
                document.cookie = c.replace(/^ +/, "")
                    .replace(/=.*/, "=;expires=" + new Date().toUTCString() + ";path=/;domain=" + window.location.hostname);
            });
        } catch(e) {
            console.warn('Cookie clear failed:', e);
        }
        
        // Clear service worker caches
        try {
            if ('caches' in window) {
                caches.keys().then(function(names) {
                    names.forEach(function(name) {
                        caches.delete(name);
                    });
                });
            }
        } catch(e) {
            console.warn('Cache clear failed:', e);
        }
        
        // Clear IndexedDB if accessible
        try {
            if (window.indexedDB) {
                indexedDB.databases().then(function(dbs) {
                    dbs.forEach(function(db) {
                        indexedDB.deleteDatabase(db.name);
                    });
                }).catch(function() {});
            }
        } catch(e) {}
    }
    
    // Check if we should redirect to login
    if (window.location.pathname !== '/login') {
        // Check if we have a token but no valid session
        const token = localStorage.getItem('kms_token');
        if (token) {
            // Verify token with server
            fetch('/api/auth/check-session', {
                credentials: 'include',
                headers: { 'Accept': 'application/json' }
            })
            .then(response => response.json())
            .then(data => {
                if (!data.authenticated) {
                    // Token is invalid, clear everything and redirect
                    forceClearAll();
                    window.location.replace('/login?t=' + Date.now() + '&forced=1');
                }
            })
            .catch(() => {
                // Network error, still clear and redirect
                forceClearAll();
                window.location.replace('/login?t=' + Date.now() + '&forced=1');
            });
        }
    }
    
    // Expose force logout function globally
    window.forceLogout = function() {
        forceClearAll();
        window.location.replace('/login?t=' + Date.now() + '&forced=1');
    };
    
    // Listen for logout events
    document.addEventListener('logout', function() {
        forceClearAll();
        window.location.replace('/login?t=' + Date.now() + '&forced=1');
    });
})();