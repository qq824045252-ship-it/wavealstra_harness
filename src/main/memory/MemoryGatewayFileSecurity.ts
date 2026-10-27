/**
 * Restrict gateway secret material to the current Windows account and SYSTEM.
 * chmod is authoritative on POSIX; on Windows an icacls failure is fatal so the
 * gateway never starts with a token/grant store protected only by a no-op mode.
 * 实现见 platform/fs-security（POSIX chmod 0600 + Windows icacls 去继承）。
 */
export { protectSecretFile as protectMemoryGatewaySecretFile } from "../platform/fs-security";
