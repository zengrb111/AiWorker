/**
 * Free stock footage / image search module.
 *
 * Searches free media sources for real footage/images matching scene keywords:
 *   1. Wikimedia Commons — public domain & CC-licensed images
 *   2. NASA Image & Video Library — public domain space/science imagery
 *   3. Internet Archive (archive.org) — public domain video & image collections
 *
 * All three sources are 100% free with no API key required.
 *
 * Flow: searchStockMedia(keywords) → returns image URL or null
 * If all sources fail, the caller falls back to AI image generation (pollinations.ai).
 */

import { writeFileSync } from "node:fs";

type SearchResult = {
  url: string;
  source: "wikimedia" | "nasa" | "archive_org";
  title: string;
  license: string;
};

// ─── Wikimedia Commons ──────────────────────────────────────────────

/**
 * Search Wikimedia Commons for images matching keywords.
 * Returns a direct image URL (original or resized to 1920px wide).
 *
 * API: https://commons.wikimedia.org/w/api.php
 * No API key needed. Rate limit: reasonable use.
 */
async function searchWikimedia(keywords: string): Promise<SearchResult | null> {
  const searchUrl =
    `https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*` +
    `&list=search&srsearch=${encodeURIComponent(keywords)}` +
    `&srnamespace=6&srlimit=8&srprop=size`;

  try {
    const resp = await fetch(searchUrl, {
      headers: { "User-Agent": "ChuangxingyunAIWorker/1.0 (educational video)" },
      signal: AbortSignal.timeout(15000),
    });
    const data = (await resp.json()) as {
      query?: { search?: Array<{ title: string }> };
    };

    const files = data.query?.search;
    if (!files || files.length === 0) return null;

    // Try the first few results to find one that resolves to an actual image URL
    for (const file of files.slice(0, 5)) {
      const title = file.title; // e.g. "File:Sunrise over mountains.jpg"
      const infoUrl =
        `https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*` +
        `&titles=${encodeURIComponent(title)}&prop=imageinfo` +
        `&iiprop=url|mime|extmetadata&iiurlwidth=1920`;

      try {
        const infoResp = await fetch(infoUrl, {
          headers: { "User-Agent": "ChuangxingyunAIWorker/1.0" },
          signal: AbortSignal.timeout(10000),
        });
        const infoData = (await infoResp.json()) as {
          query?: { pages?: Record<string, { imageinfo?: Array<{ thumburl?: string; url?: string; mime?: string }> }> };
        };

        const pages = infoData.query?.pages;
        if (!pages) continue;

        for (const page of Object.values(pages)) {
          const info = page.imageinfo?.[0];
          if (!info) continue;
          const mime = info.mime || "";
          if (!mime.startsWith("image/")) continue;
          // Prefer the thumbnail (resized to 1920px) to avoid huge originals
          const imageUrl = info.thumburl || info.url;
          if (!imageUrl) continue;

          return {
            url: imageUrl,
            source: "wikimedia",
            title: title.replace(/^File:/, ""),
            license: "CC / Public Domain (Wikimedia Commons)",
          };
        }
      } catch {
        continue;
      }
    }
  } catch {
    // Network error or timeout
  }
  return null;
}

// ─── NASA Image & Video Library ─────────────────────────────────────

/**
 * Search NASA's public image library.
 * NASA imagery is public domain (no copyright restrictions).
 *
 * API: https://images-api.nasa.gov/search
 * No API key needed.
 */
async function searchNASA(keywords: string): Promise<SearchResult | null> {
  const searchUrl =
    `https://images-api.nasa.gov/search?q=${encodeURIComponent(keywords)}` +
    `&media_type=image&page=1`;

  try {
    const resp = await fetch(searchUrl, {
      signal: AbortSignal.timeout(15000),
    });
    const data = (await resp.json()) as {
      collection?: {
        items?: Array<{
          links?: Array<{ href: string; rel?: string }>;
          data?: Array<{ title?: string; nasa_id?: string }>;
        }>;
      };
    };

    const items = data.collection?.items;
    if (!items || items.length === 0) return null;

    for (const item of items.slice(0, 5)) {
      // Find the "preview" link (medium-res image)
      const previewLink = item.links?.find((l) => l.rel === "preview" || l.rel === "preview_medium");
      if (!previewLink?.href) continue;

      const title = item.data?.[0]?.title || "NASA image";
      return {
        url: previewLink.href,
        source: "nasa",
        title,
        license: "Public Domain (NASA)",
      };
    }
  } catch {
    // Network error or timeout
  }
  return null;
}

// ─── Internet Archive (archive.org) ────────────────────────────────

/**
 * Search Internet Archive for video thumbnails / images.
 * Many items are public domain or Creative Commons.
 *
 * API: https://archive.org/advancedsearch.php
 * No API key needed.
 */
async function searchArchiveOrg(keywords: string): Promise<SearchResult | null> {
  // Search for video items — we'll use their thumbnail image
  const searchUrl =
    `https://archive.org/advancedsearch.php?q=${encodeURIComponent(
      keywords + " AND mediatype:(movies OR images)"
    )}` +
    `&fl[]=identifier&fl[]=title&fl[]=licenseurl&rows=5&output=json`;

  try {
    const resp = await fetch(searchUrl, {
      headers: { "User-Agent": "ChuangxingyunAIWorker/1.0" },
      signal: AbortSignal.timeout(15000),
    });
    const data = (await resp.json()) as {
      response?: { docs?: Array<{ identifier: string; title?: string; licenseurl?: string }> };
    };

    const docs = data.response?.docs;
    if (!docs || docs.length === 0) return null;

    // For each result, try to get the item's thumbnail
    for (const doc of docs.slice(0, 3)) {
      // Archive.org item thumbnail: https://archive.org/services/img/IDENTIFIER
      const thumbUrl = `https://archive.org/services/img/${doc.identifier}`;

      // Verify the thumbnail actually exists (HEAD check)
      try {
        const headResp = await fetch(thumbUrl, {
          method: "HEAD",
          signal: AbortSignal.timeout(8000),
        });
        if (!headResp.ok || headResp.headers.get("content-length") === "0") continue;
        const contentType = headResp.headers.get("content-type") || "";
        if (!contentType.startsWith("image/")) continue;

        return {
          url: thumbUrl,
          source: "archive_org",
          title: doc.title || doc.identifier,
          license: doc.licenseurl ? "CC (see license URL)" : "Various (Internet Archive)",
        };
      } catch {
        continue;
      }
    }
  } catch {
    // Network error or timeout
  }
  return null;
}

// ─── Combined search ────────────────────────────────────────────────

/**
 * Search all free stock media sources for an image matching the keywords.
 *
 * Tries sources in order:
 *   1. Wikimedia Commons (broadest coverage)
 *   2. NASA (space, science, earth imagery)
 *   3. Internet Archive (historical footage, educational content)
 *
 * Returns the first match found, or null if no source has a result.
 */
export async function searchStockMedia(keywords: string): Promise<SearchResult | null> {
  if (!keywords || keywords.trim().length === 0) return null;
  const query = keywords.trim();

  // Run Wikimedia + NASA in parallel (Archive.org is slower, try last)
  const [wikimedia, nasa] = await Promise.allSettled([
    searchWikimedia(query),
    searchNASA(query),
  ]);

  if (wikimedia.status === "fulfilled" && wikimedia.value) return wikimedia.value;
  if (nasa.status === "fulfilled" && nasa.value) return nasa.value;

  // Fall back to Archive.org
  const archive = await searchArchiveOrg(query).catch(() => null);
  return archive;
}

/**
 * Download a stock image and save it to a local file.
 * Returns true on success, false on failure.
 */
export async function downloadStockImage(
  imageUrl: string,
  outputPath: string
): Promise<boolean> {
  try {
    const resp = await fetch(imageUrl, {
      headers: { "User-Agent": "ChuangxingyunAIWorker/1.0 (educational video)" },
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) return false;

    const buffer = Buffer.from(await resp.arrayBuffer());
    if (buffer.length < 2000) return false; // Too small — likely an error

    writeFileSync(outputPath, buffer);
    return true;
  } catch {
    return false;
  }
}
