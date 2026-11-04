import type { SVGProps } from "react";
import {
  AlertTriangle,
  AppWindow,
  Archive,
  ArrowUp,
  ArrowUpRight,
  AtSign,
  BarChart2,
  Bell,
  Blocks,
  BookOpen,
  Bot,
  BrainCircuit,
  BrushCleaning,
  Calendar,
  Check,
  Circle,
  CircleCheck,
  CirclePause,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock,
  Columns3,
  Code2,
  Compass,
  Copy,
  Download,
  Eraser,
  Expand,
  ExternalLink,
  File,
  FileArchive,
  FileBox,
  FileCode,
  FileJson,
  FileSpreadsheet,
  FileText,
  Filter,
  Folder,
  FolderKanban,
  FolderOpen,
  GanttChart,
  GitBranch,
  Globe,
  HardDrive,
  Image,
  KeyRound,
  LayoutGrid,
  Link,
  List,
  ListTodo,
  Maximize2,
  MessageSquareDashed,
  Mic,
  Minimize2,
  MoreHorizontal,
  Palette,
  PanelLeft,
  Pause,
  Pencil,
  Pin,
  Play,
  Plus,
  Presentation,
  Puzzle,
  QrCode,
  RefreshCw,
  RotateCcw,
  Search,
  Share2,
  Shield,
  SlidersHorizontal,
  Sparkles,
  Square,
  SquarePlus,
  Table2,
  Target,
  Terminal,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  Upload,
  Users,
  Wand2,
  X,
  Zap,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
  type LucideProps,
} from "lucide-react";

export type IconProps = SVGProps<SVGSVGElement> & {
  size?: number | string;
  strokeWidth?: number | string;
};

/** 包装 Lucide 图标，保持统一的默认尺寸(16px)、描边(1.8px)和类型接口 */
function wrapLucide(IconComponent: LucideIcon) {
  return function Icon({
    size = 16,
    strokeWidth = 1.8,
    className,
    ...rest
  }: IconProps): React.JSX.Element {
    return (
      <IconComponent
        size={size}
        strokeWidth={strokeWidth}
        className={className}
        aria-hidden
        {...(rest as LucideProps)}
      />
    );
  };
}

export const IconPlus = wrapLucide(Plus);
export const IconSquarePlus = wrapLucide(SquarePlus);
export const IconPencil = wrapLucide(Pencil);
export const IconSearch = wrapLucide(Search);
export const IconPanel = wrapLucide(PanelLeft);
export const IconFilter = wrapLucide(Filter);
export const IconFolder = wrapLucide(Folder);
export const IconFolderOpen = wrapLucide(FolderOpen);
export const IconFolderKanban = wrapLucide(FolderKanban);
export const IconOpenExternal = wrapLucide(ExternalLink);

export const IconChevronDown = wrapLucide(ChevronDown);
export const IconChevronUp = wrapLucide(ChevronUp);
export const IconChevronRight = wrapLucide(ChevronRight);
export const IconChevronLeft = wrapLucide(ChevronLeft);

export const IconBell = wrapLucide(Bell);
export const IconSettings = wrapLucide(SlidersHorizontal);

/** Pi Agent 官方 Logo 图标 */
export function IconPiLogo({
  size = 16,
  className,
  ...rest
}: IconProps): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 800 800"
      width={size}
      height={size}
      fill="currentColor"
      className={className}
      aria-hidden
      {...rest}
    >
      <path
        fillRule="evenodd"
        d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29Z M282.65 282.65V400H400V282.65Z"
      />
      <path d="M517.36 400H634.72V634.72H517.36Z" />
    </svg>
  );
}

export const IconBot = IconPiLogo;
export const IconWand = wrapLucide(Wand2);
export const IconBrain = wrapLucide(BrainCircuit);
export const IconZap = wrapLucide(Zap);
export const IconUsers = wrapLucide(Users);
export const IconBlocks = wrapLucide(Blocks);
export const IconPuzzle = wrapLucide(Puzzle);
export const IconLink = wrapLucide(Link);
export const IconBook = wrapLucide(BookOpen);
export const IconSparkles = wrapLucide(Sparkles);
export const IconGrid = wrapLucide(LayoutGrid);
export const IconCompass = wrapLucide(Compass);

export const IconArrowUp = wrapLucide(ArrowUp);
export const IconMic = wrapLucide(Mic);
export const IconCopy = wrapLucide(Copy);
export const IconThumbsUp = wrapLucide(ThumbsUp);
export const IconThumbsDown = wrapLucide(ThumbsDown);
export const IconRefresh = wrapLucide(RefreshCw);
export const IconShare = wrapLucide(Share2);
export const IconMore = wrapLucide(MoreHorizontal);
export const IconPlay = wrapLucide(Play);
export const IconPause = wrapLucide(Pause);
export const IconPin = wrapLucide(Pin);
export const IconArchive = wrapLucide(Archive);
export const IconAt = wrapLucide(AtSign);
export const IconTrash = wrapLucide(Trash2);
export const IconRotate = wrapLucide(RotateCcw);
export const IconX = wrapLucide(X);
export const IconCheck = wrapLucide(Check);
export const IconClock = wrapLucide(Clock);
export const IconTarget = wrapLucide(Target);
export const IconDownload = wrapLucide(Download);
export const IconExpand = wrapLucide(Expand);
export const IconUpload = wrapLucide(Upload);
export const IconZoomIn = wrapLucide(ZoomIn);
export const IconZoomOut = wrapLucide(ZoomOut);
export const IconMaximize = wrapLucide(Maximize2);
export const IconMinimize = wrapLucide(Minimize2);

export const IconShield = wrapLucide(Shield);
export const IconAlert = wrapLucide(AlertTriangle);
export const IconCode = wrapLucide(Code2);
export const IconFile = wrapLucide(FileText);
export const IconFileText = wrapLucide(FileText);
export const IconFileGeneric = wrapLucide(File);
export const IconFileSpreadsheet = wrapLucide(FileSpreadsheet);
export const IconFileCode = wrapLucide(FileCode);
export const IconFileJson = wrapLucide(FileJson);
export const IconPresentation = wrapLucide(Presentation);
export const IconImage = wrapLucide(Image);
export const IconFileArchive = wrapLucide(FileArchive);
export const IconFileBox = wrapLucide(FileBox);

export const IconStop = wrapLucide(Square);
export const IconEraser = wrapLucide(Eraser);
export const IconBroom = wrapLucide(BrushCleaning);
export const IconList = wrapLucide(List);
export const IconListTodo = wrapLucide(ListTodo);
export const IconTable = wrapLucide(Table2);
export const IconColumns = wrapLucide(Columns3);
export const IconCircle = wrapLucide(Circle);
export const IconCircleCheck = wrapLucide(CircleCheck);
export const IconCirclePause = wrapLucide(CirclePause);
export const IconCalendar = wrapLucide(Calendar);
export const IconGantt = wrapLucide(GanttChart);
export const IconArrowUpRight = wrapLucide(ArrowUpRight);
export const IconQr = wrapLucide(QrCode);
export const IconGlobe = wrapLucide(Globe);
export const IconGitBranch = wrapLucide(GitBranch);
export const IconTerminal = wrapLucide(Terminal);
export const IconHardDrive = wrapLucide(HardDrive);
export const IconAppWindow = wrapLucide(AppWindow);
export const IconBarChart = wrapLucide(BarChart2);
export const IconKeyRound = wrapLucide(KeyRound);
export const IconPalette = wrapLucide(Palette);
export const IconBtw = wrapLucide(MessageSquareDashed);
export const IconMessageDashed = wrapLucide(MessageSquareDashed);
