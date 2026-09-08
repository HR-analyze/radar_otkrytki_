import type { NextConfig } from 'next';

const config: NextConfig = {
  // better-sqlite3 — нативный модуль, бандлить его нельзя.
  // pdfmake тянет шрифты и fontkit — в бандле роута он разваливается на
  // require встроенных .ttf, поэтому тоже остаётся внешним (см. contest-pdf.ts).
  serverExternalPackages: ['better-sqlite3', 'pdfmake'],
};

export default config;
