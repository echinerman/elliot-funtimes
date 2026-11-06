// config.js
// Shared configuration for Client and Admin portals

export const CONFIG = {
    // Firebase Project Config
    FIREBASE: {
        apiKey: "AIzaSyAH5CRCJoktmY6baXshDnOVgylHldcPa3E",
        authDomain: "elliotvip.firebaseapp.com",
        projectId: "elliotvip",
        storageBucket: "elliotvip.firebasestorage.app",
        messagingSenderId: "223494244969",
        appId: "1:223494244969:web:edcf227f756ac76ba170f8"
    },

    // Access & Onboarding
    INVITE_CODES: {
        strong8k: "FAMILY8K"
    },

    // Business Logic
    ADMIN_EMAILS: ["e.chinerman@gmail.com"],
    SUPPORT_EMAIL: "info@goelliot.vip",
    PAYMENT_EMAIL: "e.chinerman@gmail.com",
    CONTACT_LINK: "mailto:info@goelliot.vip",
    // Enabled after rules, external ingestion, and Oracle delivery acceptance checks.
    COMMUNICATIONS_ENABLED: true,
    PORTAL_SUPPORT_WEBHOOK: "https://automation.goelliot.vip/webhook/portal-support-message",
    STRONG8K_DEVICE_INFO_WEBHOOK: "https://automation.goelliot.vip/webhook/strong8k-device-info",
    STRONG8K_RENEWAL_REQUEST_WEBHOOK: "https://automation.goelliot.vip/webhook/strong8k-renewal-request",

    // UI Constants
    CURRENCY_SYMBOL: "$",
    CRYPTO_SYMBOL: "BTC"
};
