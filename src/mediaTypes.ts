// Maps file extensions to a preview strategy. Kept as plain data so the lookup
// stays a single object access — this runs on every tree click.

export type MediaKind = 'image' | 'video' | 'audio' | 'pdf';

const MIME: Record<string, { kind: MediaKind; mime: string }> = {
  // images — always fetched whole; they are small and cannot be rendered partially
  '.png':  { kind: 'image', mime: 'image/png'     },
  '.jpg':  { kind: 'image', mime: 'image/jpeg'    },
  '.jpeg': { kind: 'image', mime: 'image/jpeg'    },
  '.gif':  { kind: 'image', mime: 'image/gif'     },
  '.webp': { kind: 'image', mime: 'image/webp'    },
  '.bmp':  { kind: 'image', mime: 'image/bmp'     },
  '.ico':  { kind: 'image', mime: 'image/x-icon'  },
  '.avif': { kind: 'image', mime: 'image/avif'    },
  '.svg':  { kind: 'image', mime: 'image/svg+xml' },

  // video — always range-streamed, never downloaded whole
  '.mp4':  { kind: 'video', mime: 'video/mp4'      },
  '.m4v':  { kind: 'video', mime: 'video/mp4'      },
  '.webm': { kind: 'video', mime: 'video/webm'     },
  '.ogv':  { kind: 'video', mime: 'video/ogg'      },
  '.mov':  { kind: 'video', mime: 'video/quicktime'},
  '.mkv':  { kind: 'video', mime: 'video/x-matroska'},

  // audio — range-streamed
  '.mp3':  { kind: 'audio', mime: 'audio/mpeg'  },
  '.wav':  { kind: 'audio', mime: 'audio/wav'   },
  '.ogg':  { kind: 'audio', mime: 'audio/ogg'   },
  '.oga':  { kind: 'audio', mime: 'audio/ogg'   },
  '.flac': { kind: 'audio', mime: 'audio/flac'  },
  '.m4a':  { kind: 'audio', mime: 'audio/mp4'   },
  '.aac':  { kind: 'audio', mime: 'audio/aac'   },
  '.opus': { kind: 'audio', mime: 'audio/ogg'   },
  '.weba': { kind: 'audio', mime: 'audio/webm'  },
  '.mka':  { kind: 'audio', mime: 'audio/x-matroska' },
  '.aif':  { kind: 'audio', mime: 'audio/aiff'  },
  '.aiff': { kind: 'audio', mime: 'audio/aiff'  },
  '.wma':  { kind: 'audio', mime: 'audio/x-ms-wma' },
  '.amr':  { kind: 'audio', mime: 'audio/amr'   },

  // pdf — streamed when large: pdf.js pulls only the pages you look at
  '.pdf':  { kind: 'pdf',   mime: 'application/pdf' },
};

export function mediaTypeFor(filename: string): { kind: MediaKind; mime: string } | undefined {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return undefined;
  return MIME[filename.slice(dot).toLowerCase()];
}

// Video and audio are streamed no matter how small: a <video> element with a
// seekable source is strictly better UX than waiting for a full download, and
// it keeps the remote from pushing bytes nobody watches.
export function shouldStream(kind: MediaKind, size: number, pdfStreamThreshold: number): boolean {
  if (kind === 'video' || kind === 'audio') return true;
  if (kind === 'pdf') return size > pdfStreamThreshold;
  return false;
}
