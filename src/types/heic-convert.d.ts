// heic-convert не публикует типов; описано ровно то, чем пользуется showcase-photos.ts.
declare module 'heic-convert' {
  export default function convert(options: {
    buffer: Uint8Array | ArrayBuffer;
    format: 'JPEG' | 'PNG';
    quality?: number;
  }): Promise<ArrayBuffer>;
}
