import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { cn } from "@/lib/utils";

type Variant = "primary" | "secondary" | "ghost" | "danger";
/**
 * `none` applies no sizing so callers can compose an icon-only button without
 * fighting conflicting padding utilities from Tailwind's cascade.
 */
type Size = "sm" | "md" | "none";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  children?: ReactNode;
  /** React 19 ref-as-prop: callers can capture the underlying element. */
  ref?: Ref<HTMLButtonElement>;
}

const variants: Record<Variant, string> = {
  primary:
    "bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] active:bg-[var(--accent-hover)] focus-visible:outline-[var(--accent)]",
  secondary:
    "border border-[var(--border-strong)] bg-[var(--surface-raised)] text-[var(--ink)] hover:bg-[var(--surface)] active:bg-[var(--surface)] focus-visible:outline-[var(--accent)]",
  ghost:
    "text-[var(--ink-muted)] hover:bg-[var(--surface)] hover:text-[var(--ink)] active:bg-[var(--surface)] active:text-[var(--ink)] focus-visible:outline-[var(--accent)]",
  danger:
    "border border-[var(--border-strong)] bg-[var(--surface-raised)] text-[var(--ink)] hover:border-[var(--accent)] hover:text-[var(--accent-hover)] active:border-[var(--accent)] active:text-[var(--accent-hover)] focus-visible:outline-[var(--accent)]",
};

const sizes: Record<Size, string> = {
  sm: "h-9 gap-1.5 px-3 text-[13px]",
  md: "h-11 gap-2 px-4 text-sm",
  none: "h-9 w-9",
};

export function Button({
  variant = "secondary",
  size = "md",
  className,
  type = "button",
  ref,
  ...props
}: ButtonProps) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-xl font-medium transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-2",
        "disabled:cursor-not-allowed disabled:opacity-45",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  );
}
