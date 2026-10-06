// Spec 0011: the contract of every API route. Each handler carries `@Contract(<Module>Ops.<name>)` and
// parses its body with that operation's `body`, so the document and the validator are one object.
import { z } from 'zod';
import { PRODUCTS } from '../products.js';
import { SETTING_KEYS } from '../settings.js';
import {
  CodeConfirmBody,
  CodeRequestBody,
  LoginBody,
  MfaConfirmBody,
  MfaEnrolBody,
  MfaVerifyBody,
  StepUpBody,
} from './identity.js';
import { defineOperations, type PathParam } from './operation.js';
import { FileUploadRequestBody, ProductSetEnabledBody, SettingWriteBody } from './resources.js';
import * as R from './responses.js';

const fileId: PathParam = {
  // Documented, not enforced by a schema: the use case answers anything that is not a UUID exactly
  // like an unknown id (spec 0010 FU2: no existence oracle), never 400.
  schema: z.string().meta({ format: 'uuid' }),
  description: 'The file id. Any value that is not one of your files, including a malformed id, is 404.',
  invalid: { status: 404, code: 'resource.not_found' },
};

export const AuthOps = defineOperations({
  requestActivation: {
    operationId: 'requestActivation',
    summary: 'Send an activation code (always 202, whether or not the account exists)',
    tag: 'auth',
    body: CodeRequestBody,
    success: 202,
    response: R.MessageResponse,
    rateLimit: 'activation-request: 20/15 min per IP, 3/15 min per account',
  },
  confirmActivation: {
    operationId: 'confirmActivation',
    summary: 'Activate an account with the emailed code and a new password',
    tag: 'auth',
    body: CodeConfirmBody,
    success: 204,
    errors: { 400: ['auth.activation_invalid'], 422: ['auth.password_rejected'] },
    rateLimit: 'activation-confirm: 30/15 min per IP',
  },
  requestPasswordReset: {
    operationId: 'requestPasswordReset',
    summary: 'Send a password-reset code (always 202, whether or not the account exists)',
    tag: 'auth',
    body: CodeRequestBody,
    success: 202,
    response: R.MessageResponse,
    rateLimit: 'reset-request: 20/15 min per IP, 3/15 min per account',
  },
  confirmPasswordReset: {
    operationId: 'confirmPasswordReset',
    summary: 'Set a new password with the emailed reset code',
    tag: 'auth',
    body: CodeConfirmBody,
    success: 204,
    errors: { 400: ['auth.reset_invalid'], 422: ['auth.password_rejected'] },
    rateLimit: 'reset-confirm: 30/15 min per IP',
  },
  login: {
    operationId: 'login',
    summary: 'Sign in; sets the session, or the MFA challenge when a second factor is needed',
    tag: 'auth',
    body: LoginBody,
    success: 200,
    response: R.LoginResponse,
    errors: { 401: ['auth.invalid_credentials'] },
    rateLimit: 'login: 50/min per IP, plus per IP and identifier',
    cookies: { sets: ['session', 'mfaChallenge'] },
  },
  stepUp: {
    operationId: 'stepUp',
    summary: 'Re-authenticate this session for sensitive actions (S1–S12)',
    tag: 'auth',
    body: StepUpBody,
    success: 200,
    response: R.StepUpResponse,
    errors: {
      400: ['auth.step_up_second_factor_required'],
      401: ['auth.invalid_credentials', 'auth.mfa_invalid'],
      403: ['auth.mfa_enrolment_required'],
    },
    rateLimit: 'login buckets, plus step-up: 10/15 min per user',
    cookies: { sets: ['session'] },
  },
  logout: {
    operationId: 'logout',
    summary: 'End this session',
    tag: 'auth',
    success: 204,
    cookies: { clears: ['session'] },
  },
  me: {
    operationId: 'me',
    summary: 'The signed-in user, their permissions and MFA state',
    tag: 'auth',
    success: 200,
    response: R.MeResponse,
  },
});

export const MfaOps = defineOperations({
  verifyMfa: {
    operationId: 'verifyMfa',
    summary: 'Complete sign-in with a TOTP code or a recovery code',
    tag: 'mfa',
    body: MfaVerifyBody,
    success: 200,
    response: R.MfaVerifyResponse,
    errors: { 401: ['auth.mfa_invalid'] },
    rateLimit: 'mfa-verify: 30/15 min per IP',
    cookies: { reads: 'mfaChallenge', sets: ['session'], clears: ['mfaChallenge'] },
  },
  disableTotp: {
    operationId: 'disableTotp',
    summary: 'Turn off TOTP for yourself',
    tag: 'mfa',
    success: 200,
    response: R.TotpDisabledResponse,
    errors: { 409: ['auth.mfa_not_enrolled'] },
    cookies: { sets: ['session'] },
  },
  regenerateRecoveryCodes: {
    operationId: 'regenerateRecoveryCodes',
    summary: 'Replace your recovery codes (shown once)',
    tag: 'mfa',
    success: 200,
    response: R.RecoveryCodesResponse,
    errors: { 409: ['auth.mfa_not_enrolled'] },
  },
  beginTotpEnrolment: {
    operationId: 'beginTotpEnrolment',
    summary: 'Start TOTP enrolment: returns the secret and its otpauth URI',
    tag: 'mfa',
    body: MfaEnrolBody,
    success: 200,
    response: R.TotpEnrolmentResponse,
    errors: { 401: ['auth.invalid_credentials'], 409: ['auth.mfa_already_enrolled'] },
    rateLimit: 'mfa-enrol: 5/15 min per user',
  },
  confirmTotpEnrolment: {
    operationId: 'confirmTotpEnrolment',
    summary: 'Confirm TOTP enrolment with a code; returns recovery codes (shown once)',
    tag: 'mfa',
    body: MfaConfirmBody,
    success: 200,
    response: R.RecoveryCodesResponse,
    errors: { 400: ['auth.mfa_enrolment_expired'], 401: ['auth.mfa_invalid'] },
    rateLimit: 'mfa-confirm: 10/15 min per user',
    cookies: { sets: ['session'] },
  },
});

export const UsersOps = defineOperations({
  listUsers: {
    operationId: 'listUsers',
    summary: 'People in this institution',
    tag: 'users',
    success: 200,
    response: R.UserList,
  },
});

export const ProductsOps = defineOperations({
  listActiveProducts: {
    operationId: 'listActiveProducts',
    summary: 'Products switched on for this institution',
    tag: 'products',
    success: 200,
    response: R.ActiveProducts,
  },
  productsOverview: {
    operationId: 'productsOverview',
    summary: 'Every product: entitled by the plan, and switched on or off',
    tag: 'products',
    success: 200,
    response: R.ProductOverview,
  },
  setProductEnabled: {
    operationId: 'setProductEnabled',
    summary: 'Switch a product on or off within the plan',
    tag: 'products',
    params: {
      product: {
        schema: z.enum(PRODUCTS),
        description: 'A product key. Any other value is 404, after authorization.',
        invalid: { status: 404, code: 'resource.not_found' },
      },
    },
    body: ProductSetEnabledBody,
    success: 200,
    response: R.ProductStateResponse,
    errors: { 409: ['product.not_entitled', 'product.changed'], 422: ['product.core_required'] },
  },
});

const settingKey: PathParam = {
  schema: z.enum(SETTING_KEYS as [string, ...string[]]),
  description:
    'A setting key from the registry. An unknown key, or one whose product is off, is 404 settings.unknown_key. ' +
    'Writing needs the key’s own manage permission (x-permission-by-key).',
  invalid: { status: 404, code: 'settings.unknown_key' },
};

export const SettingsOps = defineOperations({
  listSettings: {
    operationId: 'listSettings',
    summary: 'Settings you can see, with their values',
    tag: 'settings',
    success: 200,
    response: R.SettingList,
    errors: { 500: ['settings.stored_value_invalid'] },
  },
  getSetting: {
    operationId: 'getSetting',
    summary: 'One setting, with its ETag',
    tag: 'settings',
    params: { key: settingKey },
    success: 200,
    response: R.SettingViewResponse,
    etag: true,
    errors: { 500: ['settings.stored_value_invalid'] },
  },
  putSetting: {
    operationId: 'putSetting',
    summary: 'Change a setting (If-Match required); the value must fit the chosen key',
    tag: 'settings',
    params: { key: settingKey },
    body: SettingWriteBody,
    valueBySettingKey: true,
    permissionBySettingKey: true,
    success: 200,
    response: R.SettingViewResponse,
    etag: true,
    ifMatch: true,
    errors: { 422: ['settings.invalid_value'], 500: ['settings.stored_value_invalid'] },
  },
  resetSetting: {
    operationId: 'resetSetting',
    summary: 'Return a setting to its default (If-Match required)',
    tag: 'settings',
    params: { key: settingKey },
    permissionBySettingKey: true,
    success: 200,
    response: R.SettingViewResponse,
    etag: true,
    ifMatch: true,
    errors: { 500: ['settings.stored_value_invalid'] },
  },
});

export const FilesOps = defineOperations({
  requestUpload: {
    operationId: 'requestUpload',
    summary: 'Reserve quota and get a presigned POST for one file (spec 0010)',
    tag: 'files',
    body: FileUploadRequestBody,
    success: 201,
    response: R.UploadSlotResponse,
    errors: { 409: ['file.quota_exceeded'], 422: ['file.too_large', 'file.type_not_allowed'] },
  },
  listFiles: {
    operationId: 'listFiles',
    summary: 'Your documents',
    tag: 'files',
    success: 200,
    response: R.FileList,
  },
  getFile: {
    operationId: 'getFile',
    summary: 'One of your documents and its state',
    tag: 'files',
    params: { id: fileId },
    success: 200,
    response: R.FileViewResponse,
  },
  completeUpload: {
    operationId: 'completeUpload',
    summary: 'Tell the API the upload finished; scanning starts',
    tag: 'files',
    params: { id: fileId },
    success: 200,
    response: R.FileViewResponse,
    errors: { 409: ['file.upload_incomplete'] },
  },
  downloadFile: {
    operationId: 'downloadFile',
    summary: 'The scanned bytes, verified before sending (binary)',
    tag: 'files',
    params: { id: fileId },
    success: 200,
    binary: R.FILE_DOWNLOAD_TYPES,
    errors: { 409: ['file.not_ready'] },
  },
  deleteFile: {
    operationId: 'deleteFile',
    summary: 'Delete one of your documents',
    tag: 'files',
    params: { id: fileId },
    success: 204,
  },
});

export const TenantOps = defineOperations({
  publicProfile: {
    operationId: 'publicProfile',
    summary: 'The institution’s public name and branding for this host',
    tag: 'tenant',
    success: 200,
    response: R.PublicProfileResponse,
  },
});

export const HealthOps = defineOperations({
  live: {
    operationId: 'live',
    summary: 'Process is up (no dependencies checked)',
    tag: 'operations',
    success: 200,
    response: R.LiveResponse,
  },
  ready: {
    operationId: 'ready',
    summary: 'Dependencies reachable; 503 server.not_ready otherwise',
    tag: 'operations',
    success: 200,
    response: R.ReadyResponse,
    errors: { 503: ['server.not_ready'] },
  },
});
