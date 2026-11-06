const corsHeaders = {
    entries: [
        { name: 'Access-Control-Allow-Origin', value: 'https://goelliot.vip' },
        { name: 'Access-Control-Allow-Headers', value: 'Content-Type' },
        { name: 'Vary', value: 'Origin' },
        { name: 'Cache-Control', value: 'no-store' },
        { name: 'X-Content-Type-Options', value: 'nosniff' }
    ]
};

const parseRequestCode = `
const raw = $json.body ?? $json;
let body;
try {
  body = typeof raw === 'string' ? JSON.parse(raw) : raw;
} catch {
  return [{ json: { ok: false, httpStatus: 400, code: 'INVALID_REQUEST', message: 'The request body must be valid JSON.' } }];
}
const idToken = String(body?.idToken || '').trim();
const productId = String(body?.productId || '').trim();
const licenseId = String(body?.licenseId || '').trim();
const safeId = value => /^[A-Za-z0-9_-]{1,120}$/.test(value);
if (!idToken || !safeId(productId) || !safeId(licenseId)) {
  return [{ json: { ok: false, httpStatus: 400, code: 'INVALID_REQUEST', message: 'A valid session, package, and license are required.' } }];
}
return [{ json: { ok: true, idToken, productId, licenseId } }];`;

const normalizeIdentityCode = `
const request = $('Parse request').item.json;
const user = Array.isArray($json.users) ? $json.users[0] : null;
if (!user?.localId || !user?.email) {
  return [{ json: { ok: false, httpStatus: 401, code: 'UNAUTHORIZED', message: 'Your session could not be verified. Sign in again and retry.' } }];
}
return [{ json: {
  ok: true,
  uid: String(user.localId),
  email: String(user.email).trim().toLowerCase(),
  productId: request.productId,
  licenseId: request.licenseId
} }];`;

const resolveAccountCode = `
const identity = $('Normalize identity').item.json;
const linkedAccountId = String($json?.fields?.account_id?.stringValue || '').trim();
const accountId = linkedAccountId || identity.uid;
if (!/^[A-Za-z0-9_-]{1,128}$/.test(accountId)) {
  return [{ json: { ok: false, httpStatus: 403, code: 'ACCOUNT_NOT_AVAILABLE', message: 'Your Strong8K account link could not be verified.' } }];
}
return [{ json: { ...identity, ok: true, accountId } }];`;

const authorizeMembershipCode = `
const account = $('Resolve account').item.json;
const status = String($json?.fields?.status?.stringValue || '').toLowerCase();
if (!account.ok || status !== 'active') {
  return [{ json: { ok: false, httpStatus: 403, code: 'STRONG8K_ACCESS_REQUIRED', message: 'Active Strong8K access is required to request a renewal.' } }];
}
return [{ json: { ...account, ok: true } }];`;

function normalizeProductCode(source) {
    return `
function decode(value) {
  if (!value || typeof value !== 'object') return null;
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('booleanValue' in value) return Boolean(value.booleanValue);
  if ('timestampValue' in value) return value.timestampValue;
  if ('nullValue' in value) return null;
  return null;
}
if (!$json?.fields) {
  return [{ json: { ok: false, source: '${source}' } }];
}
const fields = Object.fromEntries(Object.entries($json.fields).map(([key, value]) => [key, decode(value)]));
return [{ json: { ...fields, ok: true, source: '${source}' } }];`;
}

const prepareRequestCode = `
const account = $('Authorize membership').item.json;
const product = $json;
const allowedDurations = [1, 3, 6, 12];
const allowedDuration = value => allowedDurations.includes(Number(value || 0)) ? Number(value) : 0;
function inferDuration(value) {
  const explicit = allowedDuration(value.duration_months ?? value.subscription_months);
  if (explicit) return explicit;
  const idAndName = String(account.productId + ' ' + (value.name || '')).toLowerCase();
  if (/\\b1\\s*year\\b/.test(idAndName) || /\\b12[\\s_-]*months?\\b/.test(idAndName)) return 12;
  const match = idAndName.match(/\\b(1|3|6)[\\s_-]*months?\\b/);
  return match ? Number(match[1]) : allowedDuration(value.credits);
}
const duration = inferDuration(product);
const kind = String(product.kind || (duration ? 'renewal' : 'manual')).toLowerCase();
const active = product.active !== false;
const price = Number(product.price || 0);
const productName = String(product.name || '').trim();
if (!product.ok || !active || kind !== 'renewal' || !duration || !productName || !Number.isFinite(price) || price < 0) {
  return [{ json: { ok: false, httpStatus: 422, code: 'PACKAGE_NOT_AVAILABLE', message: 'That renewal package is not currently available.' } }];
}
const createdAt = new Date().toISOString();
const randomPart = Math.random().toString(36).slice(2, 10);
const requestId = 'renewal_' + Date.now().toString(36) + '_' + randomPart;
const lockId = account.accountId + '--' + account.licenseId;
const request = {
  id: requestId,
  account_id: account.accountId,
  auth_uid: account.uid,
  customer_email: account.email,
  license_id: account.licenseId,
  product_id: account.productId,
  product_name: productName,
  price,
  duration_months: duration,
  credits: duration,
  status: 'payment_reported',
  source: 'customer_portal',
  created_at: createdAt,
  customer_reported_at: createdAt,
  request_version: 1,
  license_reference_verified: false
};
const value = {
  string: data => ({ stringValue: String(data) }),
  integer: data => ({ integerValue: String(data) }),
  double: data => ({ doubleValue: Number(data) }),
  boolean: data => ({ booleanValue: Boolean(data) }),
  timestamp: data => ({ timestampValue: data })
};
const requestFields = {
  account_id: value.string(request.account_id),
  auth_uid: value.string(request.auth_uid),
  customer_email: value.string(request.customer_email),
  license_id: value.string(request.license_id),
  product_id: value.string(request.product_id),
  product_name: value.string(request.product_name),
  price: value.double(request.price),
  duration_months: value.integer(request.duration_months),
  credits: value.integer(request.credits),
  status: value.string(request.status),
  source: value.string(request.source),
  created_at: value.timestamp(request.created_at),
  customer_reported_at: value.timestamp(request.customer_reported_at),
  request_version: value.integer(request.request_version),
  license_reference_verified: value.boolean(false)
};
const lockFields = {
  request_id: value.string(requestId),
  account_id: value.string(account.accountId),
  license_id: value.string(account.licenseId),
  status: value.string('open'),
  created_at: value.timestamp(createdAt)
};
const base = 'projects/elliotvip/databases/(default)/documents/';
return [{ json: {
  ok: true,
  request,
  commitBody: {
    writes: [
      {
        update: { name: base + 'strong8k_renewal_requests/' + requestId, fields: requestFields },
        currentDocument: { exists: false }
      },
      {
        update: { name: base + 'strong8k_renewal_request_locks/' + lockId, fields: lockFields },
        currentDocument: { exists: false }
      }
    ]
  }
} }];`;

const normalizeCommitCode = `
const prepared = $('Prepare request').item.json;
if ($json?.error) {
  const evidence = JSON.stringify($json.error).toUpperCase();
  if (evidence.includes('409') || evidence.includes('ALREADY_EXISTS')) {
    return [{ json: { ok: false, httpStatus: 409, code: 'DUPLICATE_REQUEST', message: 'A renewal request is already waiting for this license.' } }];
  }
  return [{ json: { ok: false, httpStatus: 424, code: 'REQUEST_STORE_UNAVAILABLE', message: 'The renewal request could not be saved. Nothing was submitted; please retry.' } }];
}
return [{ json: { ok: true, request: prepared.request } }];`;

function ifNode(id, name, position) {
    return {
        id,
        name,
        type: 'n8n-nodes-base.if',
        typeVersion: 2.2,
        position,
        parameters: {
            conditions: {
                options: {
                    caseSensitive: true,
                    leftValue: '',
                    typeValidation: 'strict',
                    version: 3
                },
                conditions: [{
                    id: `${id}-condition`,
                    leftValue: '={{ $json.ok }}',
                    rightValue: true,
                    operator: { type: 'boolean', operation: 'true', singleValue: true }
                }],
                combinator: 'and'
            },
            options: {}
        }
    };
}

const firebaseCredential = {
    googleApi: { id: 'wuOeUnl3NuRU8gYA', name: 'Firebase - Strong8K Renewals' }
};

const workflow = {
    id: 'strong8kRenewalRequest20261101',
    name: 'Strong8K - Record renewal request',
    active: false,
    isArchived: false,
    nodes: [
        {
            id: 'webhook',
            name: 'Strong8K renewal request webhook',
            type: 'n8n-nodes-base.webhook',
            typeVersion: 2.1,
            position: [-1260, 0],
            webhookId: '14c91ce0-d303-4fb2-a93c-f73e9958dd7a',
            parameters: {
                httpMethod: 'POST',
                path: 'strong8k-renewal-request',
                responseMode: 'responseNode',
                options: { allowedOrigins: 'https://goelliot.vip' }
            }
        },
        {
            id: 'parse-request',
            name: 'Parse request',
            type: 'n8n-nodes-base.code',
            typeVersion: 2,
            position: [-1040, 0],
            parameters: { jsCode: parseRequestCode }
        },
        ifNode('request-valid', 'Request valid?', [-820, 0]),
        {
            id: 'verify-token',
            name: 'Verify Firebase token',
            type: 'n8n-nodes-base.httpRequest',
            typeVersion: 4.2,
            position: [-600, -120],
            onError: 'continueRegularOutput',
            parameters: {
                method: 'POST',
                url: 'https://identitytoolkit.googleapis.com/v1/accounts:lookup',
                sendQuery: true,
                queryParameters: {
                    parameters: [{ name: 'key', value: 'AIzaSyAH5CRCJoktmY6baXshDnOVgylHldcPa3E' }]
                },
                sendBody: true,
                specifyBody: 'json',
                jsonBody: '={{ { idToken: $json.idToken } }}',
                options: { timeout: 15000 }
            }
        },
        {
            id: 'normalize-identity',
            name: 'Normalize identity',
            type: 'n8n-nodes-base.code',
            typeVersion: 2,
            position: [-380, -120],
            parameters: { jsCode: normalizeIdentityCode }
        },
        ifNode('identity-valid', 'Identity valid?', [-160, -120]),
        {
            id: 'read-account-link',
            name: 'Read account link',
            type: 'n8n-nodes-base.httpRequest',
            typeVersion: 4.2,
            position: [60, -240],
            onError: 'continueRegularOutput',
            parameters: {
                url: '=https://firestore.googleapis.com/v1/projects/elliotvip/databases/(default)/documents/account_links/{{ encodeURIComponent($json.uid) }}',
                authentication: 'predefinedCredentialType',
                nodeCredentialType: 'googleApi',
                options: { timeout: 15000 }
            },
            credentials: firebaseCredential
        },
        {
            id: 'resolve-account',
            name: 'Resolve account',
            type: 'n8n-nodes-base.code',
            typeVersion: 2,
            position: [280, -240],
            parameters: { jsCode: resolveAccountCode }
        },
        ifNode('account-valid', 'Account valid?', [500, -240]),
        {
            id: 'read-membership',
            name: 'Read Strong8K membership',
            type: 'n8n-nodes-base.httpRequest',
            typeVersion: 4.2,
            position: [720, -360],
            onError: 'continueRegularOutput',
            parameters: {
                url: '=https://firestore.googleapis.com/v1/projects/elliotvip/databases/(default)/documents/users/{{ encodeURIComponent($json.accountId) }}/memberships/strong8k',
                authentication: 'predefinedCredentialType',
                nodeCredentialType: 'googleApi',
                options: { timeout: 15000 }
            },
            credentials: firebaseCredential
        },
        {
            id: 'authorize-membership',
            name: 'Authorize membership',
            type: 'n8n-nodes-base.code',
            typeVersion: 2,
            position: [940, -360],
            parameters: { jsCode: authorizeMembershipCode }
        },
        ifNode('membership-active', 'Membership active?', [1160, -360]),
        {
            id: 'read-canonical-product',
            name: 'Read canonical product',
            type: 'n8n-nodes-base.httpRequest',
            typeVersion: 4.2,
            position: [1380, -480],
            onError: 'continueRegularOutput',
            parameters: {
                url: '=https://firestore.googleapis.com/v1/projects/elliotvip/databases/(default)/documents/strong8k_products/{{ encodeURIComponent($json.productId) }}',
                authentication: 'predefinedCredentialType',
                nodeCredentialType: 'googleApi',
                options: { timeout: 15000 }
            },
            credentials: firebaseCredential
        },
        {
            id: 'normalize-canonical-product',
            name: 'Normalize canonical product',
            type: 'n8n-nodes-base.code',
            typeVersion: 2,
            position: [1600, -480],
            parameters: { jsCode: normalizeProductCode('canonical') }
        },
        ifNode('canonical-found', 'Canonical product found?', [1820, -480]),
        {
            id: 'read-legacy-product',
            name: 'Read legacy product',
            type: 'n8n-nodes-base.httpRequest',
            typeVersion: 4.2,
            position: [2040, -240],
            onError: 'continueRegularOutput',
            parameters: {
                url: '=https://firestore.googleapis.com/v1/projects/elliotvip/databases/(default)/documents/products/{{ encodeURIComponent($(\'Authorize membership\').item.json.productId) }}',
                authentication: 'predefinedCredentialType',
                nodeCredentialType: 'googleApi',
                options: { timeout: 15000 }
            },
            credentials: firebaseCredential
        },
        {
            id: 'normalize-legacy-product',
            name: 'Normalize legacy product',
            type: 'n8n-nodes-base.code',
            typeVersion: 2,
            position: [2260, -240],
            parameters: { jsCode: normalizeProductCode('legacy') }
        },
        ifNode('legacy-found', 'Legacy product found?', [2480, -240]),
        {
            id: 'prepare-request',
            name: 'Prepare request',
            type: 'n8n-nodes-base.code',
            typeVersion: 2,
            position: [2700, -600],
            parameters: { jsCode: prepareRequestCode }
        },
        ifNode('request-prepared', 'Request prepared?', [2920, -600]),
        {
            id: 'commit-request',
            name: 'Commit request and lock',
            type: 'n8n-nodes-base.httpRequest',
            typeVersion: 4.2,
            position: [3140, -720],
            onError: 'continueRegularOutput',
            parameters: {
                method: 'POST',
                url: 'https://firestore.googleapis.com/v1/projects/elliotvip/databases/(default)/documents:commit',
                authentication: 'predefinedCredentialType',
                nodeCredentialType: 'googleApi',
                sendBody: true,
                specifyBody: 'json',
                jsonBody: '={{ $json.commitBody }}',
                options: { timeout: 15000 }
            },
            credentials: firebaseCredential
        },
        {
            id: 'normalize-commit',
            name: 'Normalize commit',
            type: 'n8n-nodes-base.code',
            typeVersion: 2,
            position: [3360, -720],
            parameters: { jsCode: normalizeCommitCode }
        },
        ifNode('commit-succeeded', 'Commit succeeded?', [3580, -720]),
        {
            id: 'respond-success',
            name: 'Respond success',
            type: 'n8n-nodes-base.respondToWebhook',
            typeVersion: 1.4,
            position: [3800, -840],
            parameters: {
                respondWith: 'json',
                responseBody: '={{ { ok: true, request: $json.request, message: "Renewal request recorded." } }}',
                options: { responseCode: 201, responseHeaders: corsHeaders }
            }
        },
        {
            id: 'respond-error',
            name: 'Respond error',
            type: 'n8n-nodes-base.respondToWebhook',
            typeVersion: 1.4,
            position: [3800, 120],
            parameters: {
                respondWith: 'json',
                responseBody: '={{ { ok: false, code: $json.code, message: $json.message } }}',
                options: {
                    responseCode: '={{ $json.httpStatus || 500 }}',
                    responseHeaders: corsHeaders
                }
            }
        }
    ],
    connections: {
        'Strong8K renewal request webhook': { main: [[{ node: 'Parse request', type: 'main', index: 0 }]] },
        'Parse request': { main: [[{ node: 'Request valid?', type: 'main', index: 0 }]] },
        'Request valid?': { main: [[{ node: 'Verify Firebase token', type: 'main', index: 0 }], [{ node: 'Respond error', type: 'main', index: 0 }]] },
        'Verify Firebase token': { main: [[{ node: 'Normalize identity', type: 'main', index: 0 }]] },
        'Normalize identity': { main: [[{ node: 'Identity valid?', type: 'main', index: 0 }]] },
        'Identity valid?': { main: [[{ node: 'Read account link', type: 'main', index: 0 }], [{ node: 'Respond error', type: 'main', index: 0 }]] },
        'Read account link': { main: [[{ node: 'Resolve account', type: 'main', index: 0 }]] },
        'Resolve account': { main: [[{ node: 'Account valid?', type: 'main', index: 0 }]] },
        'Account valid?': { main: [[{ node: 'Read Strong8K membership', type: 'main', index: 0 }], [{ node: 'Respond error', type: 'main', index: 0 }]] },
        'Read Strong8K membership': { main: [[{ node: 'Authorize membership', type: 'main', index: 0 }]] },
        'Authorize membership': { main: [[{ node: 'Membership active?', type: 'main', index: 0 }]] },
        'Membership active?': { main: [[{ node: 'Read canonical product', type: 'main', index: 0 }], [{ node: 'Respond error', type: 'main', index: 0 }]] },
        'Read canonical product': { main: [[{ node: 'Normalize canonical product', type: 'main', index: 0 }]] },
        'Normalize canonical product': { main: [[{ node: 'Canonical product found?', type: 'main', index: 0 }]] },
        'Canonical product found?': { main: [[{ node: 'Prepare request', type: 'main', index: 0 }], [{ node: 'Read legacy product', type: 'main', index: 0 }]] },
        'Read legacy product': { main: [[{ node: 'Normalize legacy product', type: 'main', index: 0 }]] },
        'Normalize legacy product': { main: [[{ node: 'Legacy product found?', type: 'main', index: 0 }]] },
        'Legacy product found?': { main: [[{ node: 'Prepare request', type: 'main', index: 0 }], [{ node: 'Respond error', type: 'main', index: 0 }]] },
        'Prepare request': { main: [[{ node: 'Request prepared?', type: 'main', index: 0 }]] },
        'Request prepared?': { main: [[{ node: 'Commit request and lock', type: 'main', index: 0 }], [{ node: 'Respond error', type: 'main', index: 0 }]] },
        'Commit request and lock': { main: [[{ node: 'Normalize commit', type: 'main', index: 0 }]] },
        'Normalize commit': { main: [[{ node: 'Commit succeeded?', type: 'main', index: 0 }]] },
        'Commit succeeded?': { main: [[{ node: 'Respond success', type: 'main', index: 0 }], [{ node: 'Respond error', type: 'main', index: 0 }]] }
    },
    settings: {
        executionOrder: 'v1',
        saveDataSuccessExecution: 'none',
        saveDataErrorExecution: 'none',
        saveManualExecutions: false
    },
    staticData: null,
    meta: null,
    pinData: null,
    versionId: '1a175e87-ec87-4216-a2a3-2095841662fa',
    triggerCount: 0,
    tags: []
};

process.stdout.write(JSON.stringify([workflow]));
