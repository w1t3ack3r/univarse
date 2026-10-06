// Browser calls to the API: the generated client (spec 0011 OA8), same origin through the edge, session
// in the HttpOnly cookie only (spec 0005 W2). Nothing auth-related is ever written to localStorage or
// sessionStorage. Network failures, non-JSON answers and Problem Details all arrive as ApiError.
import { createApi } from '@univarse/api-client';

export { ApiError, contentUrl, getSetting, putSetting, resetSetting, unwrap, type FieldError, type ResponseBody, type SettingViewOf } from '@univarse/api-client';

export const client = createApi({ baseUrl: '', credentials: 'same-origin' });
