const corsHeaders = {
    entries: [
        { name: 'Access-Control-Allow-Origin', value: 'https://goelliot.vip' },
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
const profileId = String(body?.profileId || '').trim();
const licenseId = String(body?.licenseId || '').trim();
if (!idToken || !profileId || !licenseId) {
  return [{ json: { ok: false, httpStatus: 400, code: 'INVALID_REQUEST', message: 'Firebase token, profile ID, and license ID are required.' } }];
}
return [{ json: { ok: true, idToken, profileId, licenseId } }];`;

const normalizeIdentityCode = `
const request = $('Parse request').item.json;
const user = Array.isArray($json.users) ? $json.users[0] : null;
if (!user?.localId || !user?.email) {
  return [{ json: { ok: false, httpStatus: 401, code: 'UNAUTHORIZED', message: 'The admin session could not be verified.' } }];
}
return [{ json: {
  ok: true,
  uid: String(user.localId),
  email: String(user.email).trim().toLowerCase(),
  profileId: request.profileId,
  licenseId: request.licenseId
} }];`;

const authorizeAdminCode = `
const identity = $('Normalize identity').item.json;
const roleValue = $json?.fields?.platform_admin?.booleanValue === true;
const configuredEmail = identity.email === 'e.chinerman@gmail.com';
if (!roleValue && !configuredEmail) {
  return [{ json: { ok: false, httpStatus: 403, code: 'UNAUTHORIZED', message: 'This account is not authorized for Strong8K administration.' } }];
}
return [{ json: { ...identity, ok: true } }];`;

const prepareLicenseCode = `
function decode(value) {
  if (!value || typeof value !== 'object') return null;
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('booleanValue' in value) return Boolean(value.booleanValue);
  if ('timestampValue' in value) return value.timestampValue;
  if ('nullValue' in value) return null;
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(decode);
  if ('mapValue' in value) return decodeFields(value.mapValue.fields || {});
  return null;
}
function decodeFields(fields) {
  return Object.fromEntries(Object.entries(fields || {}).map(([key, value]) => [key, decode(value)]));
}
const request = $('Authorize admin').item.json;
if (!$json?.fields) {
  return [{ json: { ok: false, httpStatus: 404, code: 'NOT_FOUND', message: 'The Strong8K profile could not be found.' } }];
}
const profile = decodeFields($json.fields);
const licenses = Array.isArray(profile.licenses) ? profile.licenses : [];
const license = licenses.find(item => String(item?.id || '') === request.licenseId);
if (!license) {
  return [{ json: { ok: false, httpStatus: 404, code: 'NOT_FOUND', message: 'The Strong8K license could not be found.' } }];
}
const username = String(license.username_8k || '').trim();
const password = String(license.password_8k || '');
if (!username || !password) {
  return [{ json: { ok: false, httpStatus: 422, code: 'INVALID_CREDENTIALS', message: 'The saved license needs a username and password before it can be checked.' } }];
}
return [{ json: {
  ok: true,
  profileId: request.profileId,
  licenseId: request.licenseId,
  username,
  password,
  baseline: {
    username_8k: username,
    password_8k: password,
    expiry_date: String(license.expiry_date || '').slice(0, 10),
    status: String(license.status || ''),
    domain_8k: String(profile.domain_8k || ''),
    m3u_url_8k: String(license.m3u_url_8k || ''),
    epg_url_8k: String(license.epg_url_8k || '')
  }
} }];`;

const normalizeProviderCode = `
const prepared = $('Prepare license').item.json;
if ($json?.error) {
  return [{ json: { ok: false, httpStatus: 424, code: 'PROVIDER_UNAVAILABLE', message: 'Strong8K could not be reached. Retry in a moment.' } }];
}
const record = Array.isArray($json) ? $json[0] : $json;
const success = String(record?.status || '').toLowerCase() === 'true';
if (!success) {
  return [{ json: { ok: false, httpStatus: 422, code: 'INVALID_CREDENTIALS', message: 'Strong8K did not accept the saved username and password.' } }];
}
const username = String(record.username || '');
const password = String(record.password || '');
const expiryMatch = String(record.expire || '').match(/^(\\d{4}-\\d{2}-\\d{2})/);
const enabled = String(record.enabled ?? '').trim().toLowerCase();
const rawUrl = String(record.url || '').trim();
const providerDomain = /^https?:\\/\\/[^/]/i.test(rawUrl)
  ? (rawUrl.match(/^https?:\\/\\/[^/?#]+/i) || [])[0] || ''
  : '';
const domain = providerDomain || String(prepared.baseline.domain_8k || '').trim().replace(/\\/+$/, '');
const status = ['1', 'true', 'active', 'enabled'].includes(enabled)
  ? 'Active'
  : ['0', 'false', 'disabled', 'banned', 'expired'].includes(enabled)
    ? 'Disabled'
    : String(prepared.baseline.status || 'Active');
if (!username || !password || !expiryMatch) {
  return [{ json: { ok: false, httpStatus: 424, code: 'INVALID_PROVIDER_RESPONSE', message: 'Strong8K returned an incomplete device response.' } }];
}
const encodedUsername = encodeURIComponent(username);
const encodedPassword = encodeURIComponent(password);
const m3uUrl = domain
  ? domain + '/get.php?username=' + encodedUsername + '&password=' + encodedPassword + '&type=m3u_plus&output=ts'
  : String(prepared.baseline.m3u_url_8k || '');
const epgUrl = domain
  ? domain + '/xmltv.php?username=' + encodedUsername + '&password=' + encodedPassword
  : String(prepared.baseline.epg_url_8k || '');
return [{ json: {
  ok: true,
  checkedAt: new Date().toISOString(),
  profileId: prepared.profileId,
  licenseId: prepared.licenseId,
  baseline: prepared.baseline,
  provider: {
    username_8k: username,
    password_8k: password,
    expiry_date: expiryMatch[1],
    status,
    domain_8k: domain,
    m3u_url_8k: m3uUrl,
    epg_url_8k: epgUrl
  },
  metadata: {
    provider_user_id: String(record.user_id || ''),
    country: String(record.country || ''),
    note: String(record.note || ''),
    url: String(record.url || '')
  }
} }];`;

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

const workflow = {
    id: 'strong8kDeviceInfo20261029',
    name: 'Strong8K - Verify saved device profile',
    active: false,
    isArchived: false,
    nodes: [
        {
            id: 'webhook',
            name: 'Strong8K device info webhook',
            type: 'n8n-nodes-base.webhook',
            typeVersion: 2.1,
            position: [-1000, 0],
            webhookId: '4dbb5aa5-f363-49b2-9c36-bb94f3e692d7',
            parameters: {
                httpMethod: 'POST',
                path: 'strong8k-device-info',
                responseMode: 'responseNode',
                options: { allowedOrigins: 'https://goelliot.vip' }
            }
        },
        {
            id: 'parse-request',
            name: 'Parse request',
            type: 'n8n-nodes-base.code',
            typeVersion: 2,
            position: [-780, 0],
            parameters: { jsCode: parseRequestCode }
        },
        ifNode('request-valid', 'Request valid?', [-560, 0]),
        {
            id: 'verify-token',
            name: 'Verify Firebase token',
            type: 'n8n-nodes-base.httpRequest',
            typeVersion: 4.2,
            position: [-340, -120],
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
            position: [-120, -120],
            parameters: { jsCode: normalizeIdentityCode }
        },
        ifNode('identity-valid', 'Identity valid?', [100, -120]),
        {
            id: 'read-role',
            name: 'Read admin role',
            type: 'n8n-nodes-base.httpRequest',
            typeVersion: 4.2,
            position: [320, -240],
            onError: 'continueRegularOutput',
            parameters: {
                url: '=https://firestore.googleapis.com/v1/projects/elliotvip/databases/(default)/documents/roles/{{ encodeURIComponent($json.uid) }}',
                authentication: 'predefinedCredentialType',
                nodeCredentialType: 'googleApi',
                options: { timeout: 15000 }
            },
            credentials: {
                googleApi: { id: 'wuOeUnl3NuRU8gYA', name: 'Firebase - Strong8K Renewals' }
            }
        },
        {
            id: 'authorize-admin',
            name: 'Authorize admin',
            type: 'n8n-nodes-base.code',
            typeVersion: 2,
            position: [540, -240],
            parameters: { jsCode: authorizeAdminCode }
        },
        ifNode('admin-authorized', 'Admin authorized?', [760, -240]),
        {
            id: 'read-profile',
            name: 'Read Strong8K profile',
            type: 'n8n-nodes-base.httpRequest',
            typeVersion: 4.2,
            position: [980, -360],
            onError: 'continueRegularOutput',
            parameters: {
                url: '=https://firestore.googleapis.com/v1/projects/elliotvip/databases/(default)/documents/strong8k_profiles/{{ encodeURIComponent($json.profileId) }}',
                authentication: 'predefinedCredentialType',
                nodeCredentialType: 'googleApi',
                options: { timeout: 15000 }
            },
            credentials: {
                googleApi: { id: 'wuOeUnl3NuRU8gYA', name: 'Firebase - Strong8K Renewals' }
            }
        },
        {
            id: 'prepare-license',
            name: 'Prepare license',
            type: 'n8n-nodes-base.code',
            typeVersion: 2,
            position: [1200, -360],
            parameters: { jsCode: prepareLicenseCode }
        },
        ifNode('license-ready', 'License ready?', [1420, -360]),
        {
            id: 'device-info',
            name: 'Strong8K device_info',
            type: 'n8n-nodes-base.httpRequest',
            typeVersion: 4.2,
            position: [1640, -480],
            onError: 'continueRegularOutput',
            parameters: {
                url: 'https://8k.online-cms.ru/api/api.php',
                authentication: 'genericCredentialType',
                genericAuthType: 'httpQueryAuth',
                sendQuery: true,
                queryParameters: {
                    parameters: [
                        { name: 'action', value: 'device_info' },
                        { name: 'username', value: '={{ $json.username }}' },
                        { name: 'password', value: '={{ $json.password }}' }
                    ]
                },
                options: { timeout: 15000 }
            },
            credentials: {
                httpQueryAuth: { id: 'xjMTqmaVleHxfJ76', name: 'Strong8K Panel API' }
            }
        },
        {
            id: 'normalize-provider',
            name: 'Normalize provider response',
            type: 'n8n-nodes-base.code',
            typeVersion: 2,
            position: [1860, -480],
            parameters: { jsCode: normalizeProviderCode }
        },
        ifNode('provider-valid', 'Provider response valid?', [2080, -480]),
        {
            id: 'respond-success',
            name: 'Respond success',
            type: 'n8n-nodes-base.respondToWebhook',
            typeVersion: 1.4,
            position: [2300, -600],
            parameters: {
                respondWith: 'json',
                responseBody: '={{ $json }}',
                options: { responseHeaders: corsHeaders }
            }
        },
        {
            id: 'respond-error',
            name: 'Respond error',
            type: 'n8n-nodes-base.respondToWebhook',
            typeVersion: 1.4,
            position: [2300, 120],
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
        'Strong8K device info webhook': { main: [[{ node: 'Parse request', type: 'main', index: 0 }]] },
        'Parse request': { main: [[{ node: 'Request valid?', type: 'main', index: 0 }]] },
        'Request valid?': { main: [[{ node: 'Verify Firebase token', type: 'main', index: 0 }], [{ node: 'Respond error', type: 'main', index: 0 }]] },
        'Verify Firebase token': { main: [[{ node: 'Normalize identity', type: 'main', index: 0 }]] },
        'Normalize identity': { main: [[{ node: 'Identity valid?', type: 'main', index: 0 }]] },
        'Identity valid?': { main: [[{ node: 'Read admin role', type: 'main', index: 0 }], [{ node: 'Respond error', type: 'main', index: 0 }]] },
        'Read admin role': { main: [[{ node: 'Authorize admin', type: 'main', index: 0 }]] },
        'Authorize admin': { main: [[{ node: 'Admin authorized?', type: 'main', index: 0 }]] },
        'Admin authorized?': { main: [[{ node: 'Read Strong8K profile', type: 'main', index: 0 }], [{ node: 'Respond error', type: 'main', index: 0 }]] },
        'Read Strong8K profile': { main: [[{ node: 'Prepare license', type: 'main', index: 0 }]] },
        'Prepare license': { main: [[{ node: 'License ready?', type: 'main', index: 0 }]] },
        'License ready?': { main: [[{ node: 'Strong8K device_info', type: 'main', index: 0 }], [{ node: 'Respond error', type: 'main', index: 0 }]] },
        'Strong8K device_info': { main: [[{ node: 'Normalize provider response', type: 'main', index: 0 }]] },
        'Normalize provider response': { main: [[{ node: 'Provider response valid?', type: 'main', index: 0 }]] },
        'Provider response valid?': { main: [[{ node: 'Respond success', type: 'main', index: 0 }], [{ node: 'Respond error', type: 'main', index: 0 }]] }
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
    versionId: 'a9b664de-39a8-480a-a522-905bca131c74',
    triggerCount: 0,
    tags: []
};

process.stdout.write(JSON.stringify([workflow]));
