// Initials-monogram fallback for a null photo_path — never an empty circle. Pure + dependency-free,
// so it renders identically server-side (the data-URI print sheet) and client-side (admin display).

export function initialsOf(name: string): string {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : c === '"' ? '&quot;' : '&apos;',
  );
}

// A self-contained SVG monogram: rounded square, deterministic hue from the name, white initials.
export function monogramSvg(name: string, size = 96): string {
  const initials = initialsOf(name);
  let h = 0;
  for (const c of name || '') h = (h * 31 + c.charCodeAt(0)) % 360;
  const bg = `hsl(${h}, 45%, 52%)`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<rect width="${size}" height="${size}" rx="${(size / 8).toFixed(1)}" fill="${bg}"/>` +
    `<text x="50%" y="50%" dy=".35em" text-anchor="middle" font-family="sans-serif" ` +
    `font-size="${(size * 0.4).toFixed(1)}" fill="#fff">${escapeXml(initials)}</text>` +
    `</svg>`
  );
}
