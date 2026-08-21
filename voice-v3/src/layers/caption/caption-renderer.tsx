import type { CSSProperties, ReactNode } from "react";

export type CaptionRendererProps = {
  readonly text: string;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly children?: ReactNode;
};

/**
 * Browser-native Unicode direction resolution keeps Arabic/English mixed text
 * readable while preserving the exact spoken string.
 */
export function CaptionRenderer({
  text,
  className,
  style,
  children,
}: CaptionRendererProps) {
  return (
    <div dir="auto" className={className} style={style} data-caption-text={text}>
      {children ?? text}
    </div>
  );
}
