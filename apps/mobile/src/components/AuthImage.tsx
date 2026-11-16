import { useEffect, useState } from "react";
import { Image, type ImageResizeMode, type ImageStyle, type StyleProp } from "react-native";
import { api, authHeaders } from "../lib/api";

interface Props {
  /** GridFS file id (content.fileKey or content.thumbKey). */
  fileId: string;
  className?: string;
  style?: StyleProp<ImageStyle>;
  resizeMode?: ImageResizeMode;
  onLoad?: (size: { width: number; height: number }) => void;
}

/**
 * Loads a private file with the Authorization header. The access token lives 15 minutes, so on a
 * load error the session is refreshed once (any authenticated call does it) and the image retried.
 */
export function AuthImage({ fileId, className, style, resizeMode = "cover", onLoad }: Props) {
  const [headers, setHeaders] = useState<Record<string, string> | null>(null);
  const [retried, setRetried] = useState(false);

  useEffect(() => {
    let alive = true;
    void authHeaders().then((h) => alive && setHeaders(h));
    return () => {
      alive = false;
    };
  }, [fileId, retried]);

  async function onError() {
    if (retried) return;
    try {
      await api.me(); // refreshes the token on 401
    } catch {
      // offline: the retry below just fails again, nothing else to do
    }
    setRetried(true); // re-reads the (possibly new) token and reloads once
  }

  if (!headers) return <Image className={className} style={style} />;
  return (
    <Image
      className={className}
      style={style}
      source={{ uri: api.fileUrl(fileId), headers }}
      resizeMode={resizeMode}
      resizeMethod="resize"
      onError={() => void onError()}
      onLoad={onLoad ? (e) => onLoad(e.nativeEvent.source) : undefined}
    />
  );
}
