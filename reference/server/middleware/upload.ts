import multer from 'multer';

export const MulterError = multer.MulterError;

export const upload = multer({
  storage: multer.memoryStorage(),
});
