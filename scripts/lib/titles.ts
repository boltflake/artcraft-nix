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

/** Every package, in SOURCES' order (the README's and the page's), each
 * app followed by its companion. */
export const PACKAGE_ORDER: string[] = SOURCES.flatMap((s) => Object.keys(s.packages));

export const titleOf = (pkg: string) => TITLES[pkg]?.title ?? pkg;
