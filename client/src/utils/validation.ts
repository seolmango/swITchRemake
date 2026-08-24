export const isEmail = (value: string) => value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
export const isPassword = (value: string) => value.length >= 8 && value.length <= 20 && /^[A-Za-z0-9!@#$%^&*]+$/.test(value);
export const isNickname = (value: string) => value.length >= 2 && value.length <= 12 && /^[A-Za-z0-9가-힣]+$/.test(value);
export const isVerificationCode = (value: string) => /^\d{6}$/.test(value);
export const isRoomName = (value: string) => value.trim().length >= 1 && value.trim().length <= 20;
export const isRoomId = (value: string) => /^[A-HJ-NP-Z2-9]{6}$/.test(value);
export const isRoomPassword = (value: string) => value.length >= 1 && value.length <= 12;
