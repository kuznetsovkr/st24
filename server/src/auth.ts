import jwt from 'jsonwebtoken';

export type AuthPayload = {
  userId: string;
  phone: string;
  role: string;
};

const getJwtSecret = () => {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    throw new Error('JWT_SECRET is required');
  }
  return jwtSecret;
};

export const signToken = (payload: AuthPayload) =>
  jwt.sign(payload, getJwtSecret(), { expiresIn: '7d' });

export const verifyToken = (token: string) => jwt.verify(token, getJwtSecret()) as AuthPayload;
