import {
  Activity,
  AlertCircle,
  AlertTriangle,
  Anchor,
  ArrowLeft,
  ArrowUp,
  AudioWaveform,
  Captions,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleMinus,
  CircleUserRound,
  Cloud,
  CloudUpload,
  Copy,
  Database,
  DatabaseZap,
  Eye,
  EyeOff,
  Flame,
  Gauge,
  Info,
  Loader2,
  Mic,
  MicOff,
  Moon,
  Pencil,
  Phone,
  PhoneOff,
  Pin,
  PinOff,
  RotateCw,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Square,
  Sun,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  User,
  Volume2,
  Waves,
  Wind,
  X,
  createElement,
  createIcons as lucideCreateIcons,
} from "lucide";

const definitions = {
  Activity,
  AlertCircle,
  AlertTriangle,
  Anchor,
  ArrowLeft,
  ArrowUp,
  AudioWaveform,
  Captions,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleMinus,
  CircleUserRound,
  Cloud,
  CloudCheck: Cloud,
  CloudUpload,
  Copy,
  Database,
  DatabaseZap,
  Eye,
  EyeOff,
  Flame,
  Gauge,
  Info,
  Loader2,
  Mic,
  MicOff,
  Moon,
  Pencil,
  Phone,
  PhoneOff,
  Pin,
  PinOff,
  RotateCw,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Square,
  Sun,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  User,
  Volume2,
  Waves,
  Wind,
  X,
};

const kebab = (name) => name
  .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
  .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
  .replace(/([A-Za-z])([0-9])/g, "$1-$2")
  .toLowerCase();

const icons = {};
for (const [name, definition] of Object.entries(definitions)) {
  icons[name] = definition;
  icons[kebab(name)] = definition;
}

function createIcons(options = {}) {
  return lucideCreateIcons({ ...options, icons });
}

window.lucide = Object.freeze({
  createElement,
  createIcons,
  icons: Object.freeze(icons),
});
