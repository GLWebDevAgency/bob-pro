import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

function IconBase({ children, ...props }: IconProps) {
  return (
    <svg aria-hidden="true" fill="none" height="20" viewBox="0 0 24 24" width="20" {...props}>
      {children}
    </svg>
  );
}

const stroke = { stroke: 'currentColor', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, strokeWidth: 1.8 };

export function FolderIcon(props: IconProps) {
  return <IconBase {...props}><path d="M3.5 6.75h6l1.75 2h9.25v8.75a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V6.75Z" {...stroke} /><path d="M3.5 9h17" {...stroke} /></IconBase>;
}

export function UploadIcon(props: IconProps) {
  return <IconBase {...props}><path d="M12 15.5V4.5m0 0L7.75 8.75M12 4.5l4.25 4.25" {...stroke} /><path d="M5 13.5v5a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5v-5" {...stroke} /></IconBase>;
}

export function DocumentIcon(props: IconProps) {
  return <IconBase {...props}><path d="M6 3.5h8l4 4v13H6v-17Z" {...stroke} /><path d="M14 3.5v4h4M9 12h6M9 15.5h6" {...stroke} /></IconBase>;
}

export function PenIcon(props: IconProps) {
  return <IconBase {...props}><path d="m5 16.5-1 3.5 3.5-1L18.75 7.75a2.12 2.12 0 0 0-3-3L5 16.5Z" {...stroke} /><path d="m13.75 6.75 3.5 3.5M10 20h10" {...stroke} /></IconBase>;
}

export function ShieldIcon(props: IconProps) {
  return <IconBase {...props}><path d="M12 3.5 19 6v5.5c0 4.1-2.35 7.2-7 9-4.65-1.8-7-4.9-7-9V6l7-2.5Z" {...stroke} /><path d="m9 12 2 2 4-4" {...stroke} /></IconBase>;
}

export function CheckIcon(props: IconProps) {
  return <IconBase {...props}><path d="m6 12.25 3.75 3.75L18 7.75" {...stroke} /></IconBase>;
}

export function AlertIcon(props: IconProps) {
  return <IconBase {...props}><path d="M12 4 21 20H3L12 4Z" {...stroke} /><path d="M12 9.5v4.5M12 17.25h.01" {...stroke} /></IconBase>;
}

export function CloseIcon(props: IconProps) {
  return <IconBase {...props}><path d="m6 6 12 12M18 6 6 18" {...stroke} /></IconBase>;
}

export function TrashIcon(props: IconProps) {
  return <IconBase {...props}><path d="M4.5 7h15M9 3.5h6L16 7H8l1-3.5ZM7 7l.75 13h8.5L17 7M10 10.5v6M14 10.5v6" {...stroke} /></IconBase>;
}

export function DownloadIcon(props: IconProps) {
  return <IconBase {...props}><path d="M12 4.5v11m0 0 4-4m-4 4-4-4" {...stroke} /><path d="M5 18v2h14v-2" {...stroke} /></IconBase>;
}

export function ChevronIcon(props: IconProps) {
  return <IconBase {...props}><path d="m9 6 6 6-6 6" {...stroke} /></IconBase>;
}

export function ArrowLeftIcon(props: IconProps) {
  return <IconBase {...props}><path d="M19 12H5m0 0 5-5m-5 5 5 5" {...stroke} /></IconBase>;
}

export function CalendarIcon(props: IconProps) {
  return <IconBase {...props}><path d="M5 5.5h14v14H5v-14ZM8 3.5v4M16 3.5v4M5 9h14" {...stroke} /></IconBase>;
}

export function MoreIcon(props: IconProps) {
  return <IconBase {...props}><circle cx="12" cy="5" r="1.1" fill="currentColor" /><circle cx="12" cy="12" r="1.1" fill="currentColor" /><circle cx="12" cy="19" r="1.1" fill="currentColor" /></IconBase>;
}

export function MenuIcon(props: IconProps) {
  return <IconBase {...props}><path d="M4 6.5h16M4 12h16M4 17.5h16" {...stroke} /></IconBase>;
}

export function PrintIcon(props: IconProps) {
  return <IconBase {...props}><path d="M7 8V3.5h10V8M7 16H4.5v-6.5h15V16H17M7 13.5h10v7H7v-7Z" {...stroke} /><path d="M16.5 11h.01" {...stroke} /></IconBase>;
}

export function LockIcon(props: IconProps) {
  return <IconBase {...props}><rect x="5" y="10" width="14" height="10" rx="2" {...stroke} /><path d="M8.5 10V7.5a3.5 3.5 0 0 1 7 0V10" {...stroke} /></IconBase>;
}

export function RefreshIcon(props: IconProps) {
  return <IconBase {...props}><path d="M19 7.5A8 8 0 0 0 5.25 6L4 8M5 16.5A8 8 0 0 0 18.75 18L20 16" {...stroke} /><path d="M4 4v4h4M20 20v-4h-4" {...stroke} /></IconBase>;
}

export function PlusIcon(props: IconProps) {
  return <IconBase {...props}><path d="M12 5v14M5 12h14" {...stroke} /></IconBase>;
}
