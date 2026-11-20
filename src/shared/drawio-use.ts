export const DRAWIO_USE_TOOLS = {
  create: "drawio_create",
  read: "drawio_read",
  edit: "drawio_edit",
  layout: "drawio_layout",
  export: "drawio_export",
  shapes: "drawio_shapes",
  reference: "drawio_reference",
  link: "drawio_link",
} as const;

export const DRAWIO_READ_TOOLS: readonly string[] = [
  DRAWIO_USE_TOOLS.read, DRAWIO_USE_TOOLS.shapes, DRAWIO_USE_TOOLS.reference, DRAWIO_USE_TOOLS.link,
];

export const isDrawioFile = (name: string) => /\.drawio$/i.test(name);
