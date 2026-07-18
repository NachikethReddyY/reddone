type AccountAvatarProps = {
  name: string;
  image?: string | null | undefined;
  className?: string | undefined;
  size?: number;
};

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0]?.[0] ?? ""}${parts.at(-1)?.[0] ?? ""}` : parts[0]?.slice(0, 2) ?? "OW")
    .toLocaleUpperCase();
}

function safeImage(value: string | null | undefined) {
  if (!value) return null;
  if (/^data:image\/(?:webp|png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) return value;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function AccountAvatar({ name, image, className = "", size = 36 }: AccountAvatarProps) {
  const source = safeImage(image);
  return (
    <span
      aria-hidden="true"
      className={`account-avatar ${source ? "has-image" : ""} ${className}`}
      style={{ height: size, width: size }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- database-backed avatars are already normalized WebP data URLs */}
      {source ? <img alt="" decoding="async" height={size} src={source} width={size} /> : initials(name)}
    </span>
  );
}
