import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type { RequestHandler } from 'express';
import multer from 'multer';

const uploadsDir = path.resolve(process.cwd(), 'uploads');
const MAX_UPLOAD_FILE_SIZE = 5 * 1024 * 1024;
const MAX_UPLOAD_FILES = 5;

const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

type DetectedImageType = {
  ext: '.jpg' | '.png' | '.webp';
  mime: 'image/jpeg' | 'image/png' | 'image/webp';
};

export class UploadValidationError extends Error {}

const isSafeUploadFilename = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp)$/i.test(
    value
  );

export const ensureUploadsDir = () => {
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }
};

const removeFileIfExists = async (fullPath: string) => {
  try {
    await fs.promises.unlink(fullPath);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== 'ENOENT') {
      throw error;
    }
  }
};

const detectImageType = (buffer: Buffer): DetectedImageType | null => {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { ext: '.jpg', mime: 'image/jpeg' };
  }

  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { ext: '.png', mime: 'image/png' };
  }

  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return { ext: '.webp', mime: 'image/webp' };
  }

  return null;
};

const assertAllowedUploadMetadata = (file: Express.Multer.File) => {
  const originalExt = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(originalExt)) {
    throw new UploadValidationError('Unsupported file extension');
  }

  if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
    throw new UploadValidationError('Unsupported file MIME type');
  }

  if (!file.buffer || file.buffer.length === 0) {
    throw new UploadValidationError('Empty upload payload');
  }
};

const saveValidatedUpload = async (file: Express.Multer.File): Promise<Express.Multer.File> => {
  assertAllowedUploadMetadata(file);

  const detected = detectImageType(file.buffer);
  if (!detected) {
    throw new UploadValidationError('Unsupported file signature');
  }

  if (file.mimetype !== detected.mime) {
    throw new UploadValidationError('File MIME type does not match content signature');
  }

  const filename = `${randomUUID()}${detected.ext}`;
  const fullPath = path.join(uploadsDir, filename);
  await fs.promises.writeFile(fullPath, file.buffer, { flag: 'wx' });

  return {
    ...file,
    filename,
    destination: uploadsDir,
    path: fullPath
  };
};

const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_FILE_SIZE,
    files: MAX_UPLOAD_FILES
  }
});

const withSingleUpload =
  (fieldName: string): RequestHandler =>
  (req, res, next) => {
    memoryUpload.single(fieldName)(req, res, async (error: unknown) => {
      if (error) {
        next(error);
        return;
      }

      const file = req.file;
      if (!file) {
        next();
        return;
      }

      try {
        ensureUploadsDir();
        req.file = await saveValidatedUpload(file);
        next();
      } catch (saveError) {
        next(saveError);
      }
    });
  };

const withArrayUpload =
  (fieldName: string, maxCount: number): RequestHandler =>
  (req, res, next) => {
    memoryUpload.array(fieldName, maxCount)(req, res, async (error: unknown) => {
      if (error) {
        next(error);
        return;
      }

      const files = Array.isArray(req.files) ? (req.files as Express.Multer.File[]) : [];
      if (files.length === 0) {
        next();
        return;
      }

      ensureUploadsDir();
      const saved: Express.Multer.File[] = [];
      try {
        for (const file of files) {
          saved.push(await saveValidatedUpload(file));
        }
        req.files = saved;
        next();
      } catch (saveError) {
        await Promise.allSettled(saved.map((file) => removeFileIfExists(path.join(uploadsDir, file.filename))));
        next(saveError);
      }
    });
  };

const withFieldsUpload =
  (fields: ReadonlyArray<{ name: string; maxCount?: number }>): RequestHandler =>
  (req, res, next) => {
    memoryUpload.fields(fields)(req, res, async (error: unknown) => {
      if (error) {
        next(error);
        return;
      }

      const filesByField =
        req.files && typeof req.files === 'object' && !Array.isArray(req.files)
          ? (req.files as { [fieldname: string]: Express.Multer.File[] })
          : {};
      const savedByField: { [fieldname: string]: Express.Multer.File[] } = {};
      const savedFilenames: string[] = [];

      ensureUploadsDir();
      try {
        for (const [fieldname, files] of Object.entries(filesByField)) {
          if (!Array.isArray(files) || files.length === 0) {
            continue;
          }
          const savedFiles: Express.Multer.File[] = [];
          for (const file of files) {
            const saved = await saveValidatedUpload(file);
            savedFiles.push(saved);
            savedFilenames.push(saved.filename);
          }
          if (savedFiles.length > 0) {
            savedByField[fieldname] = savedFiles;
          }
        }

        req.files = savedByField;
        next();
      } catch (saveError) {
        await Promise.allSettled(
          savedFilenames.map((filename) => removeFileIfExists(path.join(uploadsDir, filename)))
        );
        next(saveError);
      }
    });
  };

export const upload = {
  single: withSingleUpload,
  array: withArrayUpload,
  fields: withFieldsUpload
};

export const toPublicUrl = (filename: string) =>
  isSafeUploadFilename(filename) ? `/uploads/${filename}` : '';

export const removeUploadedFiles = (filenames: string[]) => {
  filenames.forEach((filename) => {
    if (!isSafeUploadFilename(filename)) {
      return;
    }
    const fullPath = path.join(uploadsDir, filename);
    if (fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
    }
  });
};
