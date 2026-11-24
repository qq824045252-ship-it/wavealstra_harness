import type { SVGProps } from "react";
import { brandPaths, iconPaths } from "./icons.generated";

// Official Pi Agent artwork used as the identity for Dots.
const piMark = "M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29Z M282.65 282.65V400H400V282.65Z M517.36 400H634.72V634.72H517.36Z";

export type UiIconName = keyof typeof iconPaths | "pi";
export type UiIconProps = Omit<SVGProps<SVGSVGElement>, "name"> & {
  size?: number | string;
  strokeWidth?: number | string;
  accent?: boolean;
};

export function UiIcon({
  name, size = 16, accent = false, strokeWidth, ...props
}: UiIconProps & { name: UiIconName }): React.JSX.Element {
  const isPi = name === "pi";
  const [base, color] = isPi ? [piMark, undefined] : iconPaths[name];
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox={isPi ? "0 0 800 800" : "0 0 128 128"} width={size} height={size}
      aria-hidden="true" focusable="false" strokeWidth={strokeWidth} {...props} data-icon={name}>
      <path d={base} fill="currentColor" fillRule="evenodd" />
      {accent && color && (
        <path d={color} fill="light-dark(#ac4931, #f79a7a)" fillRule="evenodd" />
      )}
    </svg>
  );
}

export function createUiIcon(name: UiIconName) {
  return function NamedUiIcon(props: UiIconProps): React.JSX.Element {
    return <UiIcon name={name} {...props} />;
  };
}

export function MyBuddyBrandIcon({ size = 28, ...props }: UiIconProps): React.JSX.Element {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width={size} height={size}
      aria-hidden="true" focusable="false" {...props} data-icon="mybuddy-brand">
      <path d={brandPaths.tile} fill="#a34934" fillRule="evenodd" />
      <path d={brandPaths.bubble} fill="#fff1df" fillRule="evenodd" />
      <path d={brandPaths.details} fill="#462414" fillRule="evenodd" />
    </svg>
  );
}
