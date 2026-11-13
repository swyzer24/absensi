import type { EmployeeDecryptedPII, EmployeeEncryptedPII } from '../types';

const DEFAULT_VAULT_PASSPHRASE = 'presensia-enterprise-vault-key-2026';
const PBKDF2_SALT = new TextEncoder().encode('presensia-cloud-aes256-salt-v1');

function arrayBufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function computeSHA256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function deriveAesGcmKey(passphrase: string): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: PBKDF2_SALT,
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function getKeyFingerprint(passphrase = DEFAULT_VAULT_PASSPHRASE): Promise<string> {
  const hash = await computeSHA256(`fp:${passphrase}`);
  return hash.slice(0, 16).toUpperCase();
}

export async function encryptEmployeePII(
  pii: EmployeeDecryptedPII,
  ownerUid: string,
  passphrase = DEFAULT_VAULT_PASSPHRASE
): Promise<Omit<EmployeeEncryptedPII, 'updatedAt'>> {
  const key = await deriveAesGcmKey(passphrase);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(pii));

  const cipherBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    plaintext
  );

  const keyFingerprint = await getKeyFingerprint(passphrase);

  return {
    ownerUid,
    algorithm: 'AES-256-GCM',
    ciphertext: arrayBufferToBase64(cipherBuffer),
    iv: arrayBufferToBase64(iv),
    keyFingerprint,
  };
}

export async function decryptEmployeePII(
  encrypted: Pick<EmployeeEncryptedPII, 'ciphertext' | 'iv'>,
  passphrase = DEFAULT_VAULT_PASSPHRASE
): Promise<EmployeeDecryptedPII> {
  const key = await deriveAesGcmKey(passphrase);
  const iv = base64ToUint8Array(encrypted.iv);
  const cipherBytes = base64ToUint8Array(encrypted.ciphertext);

  const plainBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    key,
    cipherBytes as unknown as BufferSource
  );

  const decoded = new TextDecoder().decode(plainBuffer);
  return JSON.parse(decoded) as EmployeeDecryptedPII;
}

export function getActiveVaultPassphrase(): string {
  if (typeof window !== 'undefined') {
    return window.sessionStorage.getItem('presensia_vault_key') || DEFAULT_VAULT_PASSPHRASE;
  }
  return DEFAULT_VAULT_PASSPHRASE;
}

export function setActiveVaultPassphrase(passphrase: string): void {
  if (typeof window !== 'undefined') {
    if (!passphrase.trim()) {
      window.sessionStorage.removeItem('presensia_vault_key');
    } else {
      window.sessionStorage.setItem('presensia_vault_key', passphrase);
    }
  }
}
