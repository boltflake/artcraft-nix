// Each package's name as the status page shows it, and a line about it: the
// apps' from their metainfo summaries (pkgs/apps.nix), in upstream's own
// spelling of the names (their release titles).
import { SOURCES } from "../../shared/sources.ts";

export interface Title {
  title: string;
  description: string;
  /** A companion download: listed under the app it comes with. */
  companionOf?: string;
}

export const TITLES: Record<string, Title> = {
  photocraft: { title: "PhotoCraft", description: "Edit photos and layered PSD documents" },
  vectorcraft: { title: "VectorCraft", description: "Draw and edit vector illustrations, SVG and PDF" },
  filmcraft: { title: "FilmCraft", description: "Edit video, color and sound" },
  lightcraft: { title: "LightCraft", description: "Organise photos and develop raw files, non-destructively" },
  pdfcraft: { title: "PdfCraft", description: "Read, organize, combine, split and secure PDFs" },
  "pdfcraft-cli": { title: "PdfCraft CLI", description: "PdfCraft's command-line tool", companionOf: "pdfcraft" },
  effectcraft: { title: "EffectCraft", description: "Motion graphics and visual effects compositor" },
  anicraft: { title: "AniCraft", description: "Draw and animate 2D vector art on a timeline" },
  designcraft: { title: "DesignCraft", description: "Lay out magazines, books and print documents" },
  figcraft: { title: "FigCraft", description: "Design and prototype user interfaces" },
  "figcraft-server": { title: "FigCraft server", description: "FigCraft's headless server", companionOf: "figcraft" },
  texturecraft: { title: "TextureCraft", description: "Paint PBR textures directly on 3D meshes" },
  materialcraft: { title: "MaterialCraft", description: "Design procedural PBR materials with node graphs" },
  soundcraft: { title: "SoundCraft", description: "Record, edit and mix audio and MIDI" },
  wordcraft: { title: "WordCraft", description: "Write and design documents; open and save Word files" },
  deckcraft: { title: "DeckCraft", description: "Create and present slide decks" },
  cadcraft: { title: "CADCraft", description: "Draft, dimension and plot 2D drawings" },
  gridcraft: { title: "GridCraft", description: "Calculate, analyse and chart data in workbooks" },
  "craft-anything": { title: "Craft Anything", description: "Find out how any software works, then craft your own" },
  "artcraft-studio": { title: "ArtCraft Studio", description: "The ArtCraft desktop studio" },
};

/** The categories the README's package tables and the status page's
 * sections use, in their order, each with its apps in alphabetical order
 * (companions excluded: they're listed under their app). A test holds the
 * README to this list. */
export interface Category {
  id: string;
  title: string;
  apps: string[];
}
export const CATEGORIES: Category[] = [
  { id: "photos", title: "Photos and images", apps: ["lightcraft", "photocraft"] },
  { id: "video", title: "Video, animation and sound", apps: ["anicraft", "effectcraft", "filmcraft", "soundcraft"] },
  { id: "3d", title: "3D textures and materials", apps: ["materialcraft", "texturecraft"] },
  { id: "design", title: "Design and drawing", apps: ["cadcraft", "designcraft", "figcraft", "vectorcraft"] },
  { id: "documents", title: "Documents and office", apps: ["deckcraft", "gridcraft", "pdfcraft", "wordcraft"] },
  { id: "ai", title: "AI", apps: ["artcraft-studio", "craft-anything"] },
];

/** The companions of an app, in SOURCES' order. */
export const companionsOf = (app: string): string[] =>
  SOURCES.flatMap((s) => Object.keys(s.packages)).filter((n) => TITLES[n]?.companionOf === app);

/** Every package in the README's and the page's order: by category, each
 * app followed by its companions. */
export const PACKAGE_ORDER: string[] = CATEGORIES.flatMap((c) => c.apps.flatMap((a) => [a, ...companionsOf(a)]));

export const titleOf = (pkg: string) => TITLES[pkg]?.title ?? pkg;
