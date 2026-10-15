import type { NextConfig } from 'next';

const config: NextConfig = {
  // better-sqlite3 — нативный модуль, бандлить его нельзя.
  // pdfmake тянет шрифты и fontkit — в бандле роута он разваливается на
  // require встроенных .ttf, поэтому тоже остаётся внешним (см. contest-pdf.ts).
  // sharp — тоже нативный, heic-convert тянет libheif в WebAssembly: оба
  // нужны только роуту фото витрины и в бандл не кладутся.
  serverExternalPackages: ['better-sqlite3', 'pdfmake', 'sharp', 'heic-convert'],
  experimental: {
    // Фото витрины, которое браузер не смог ужать (HEIC, TIFF), приходит
    // целиком — до 15 МБ (MAX_UPLOAD_BYTES). По умолчанию proxy режет тело
    // на 10 МБ, и такой запрос разваливался бы на разборе формы.
    proxyClientMaxBodySize: '16mb',
  },
};

export default config;
