import type { Display } from "electron";
import { WindowsAutomationError, type Rect, type WindowInfo } from "./windowsAutomationProtocol";

export interface WindowCaptureResult {
  screenshot: Uint8Array;
  details: {
    displayId: string;
    scaleFactor: number;
    captureRectDip: { x: number; y: number; width: number; height: number };
    captureRectPhysical: Rect;
    captureMode: "foreground-display-crop";
    coordinateSpace: "client-dip-aligned-pixels" | "window-dip-aligned-pixels";
    mimeType: "image/jpeg";
    /** Physical client pixels per returned image pixel (1 when the capture is not downscaled). */
    imageScale: number;
    imageSize: { width: number; height: number };
  };
}

/**
 * Pi resizes tool-result images above 2000px and re-encodes them (about 1s for
 * a 2560x1440 frame). Capping here keeps the capture deterministic, reports the
 * exact scale to the model, and emits JPEG so the payload stays small.
 */
const MAX_CAPTURE_EDGE = 2000;
const CAPTURE_JPEG_QUALITY = 70;

function contains(outer: Rect, inner: Rect): boolean {
  return inner.left >= outer.left && inner.top >= outer.top && inner.right <= outer.right && inner.bottom <= outer.bottom;
}

export class WindowCaptureService {
  async capture(window: WindowInfo, clientOnly = true): Promise<WindowCaptureResult> {
    // Lazy require keeps node-only contract tests independent from Electron startup.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { desktopCapturer, screen } = require("electron") as typeof import("electron");
    const monitorRect = window.monitorRect;
    if (!monitorRect) {
      throw new WindowsAutomationError("CAPTURE_FAILED", "Target monitor information is unavailable", { window });
    }
    const target: Rect = clientOnly
      ? {
          left: window.clientOrigin.x,
          top: window.clientOrigin.y,
          right: window.clientOrigin.x + window.clientRect.width,
          bottom: window.clientOrigin.y + window.clientRect.height,
          width: window.clientRect.width,
          height: window.clientRect.height,
        }
      : window.windowRect;
    if (!contains(monitorRect, target)) {
      throw new WindowsAutomationError(
        "CAPTURE_SPANS_MULTIPLE_DISPLAYS",
        "Target capture rectangle spans multiple displays",
        { target, monitorRect },
      );
    }
    const electronDipRect = screen.screenToDipRect(null, {
      x: target.left,
      y: target.top,
      width: target.width,
      height: target.height,
    });
    const display = screen.getDisplayMatching(electronDipRect);
    this.assertDisplayMatchesMonitor(display, monitorRect, screen);
    const width = Math.max(1, Math.round(display.size.width * display.scaleFactor));
    const height = Math.max(1, Math.round(display.size.height * display.scaleFactor));
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width, height },
      fetchWindowIcons: false,
    });
    const source = sources.find((item) => item.display_id === String(display.id));
    if (!source || source.thumbnail.isEmpty()) {
      throw new WindowsAutomationError("CAPTURE_FAILED", "Exact display capture is unavailable", {
        displayId: String(display.id),
      });
    }
    const crop = {
      x: target.left - monitorRect.left,
      y: target.top - monitorRect.top,
      width: target.width,
      height: target.height,
    };
    if (crop.x < 0 || crop.y < 0 || crop.x + crop.width > width || crop.y + crop.height > height) {
      throw new WindowsAutomationError("CAPTURE_FAILED", "Target rectangle cannot be mapped into the display capture", {
        crop, captureSize: { width, height }, display, monitorRect,
      });
    }
    const physicalImage = source.thumbnail.crop(crop);
    if (physicalImage.isEmpty()) {
      throw new WindowsAutomationError("CAPTURE_FAILED", "Window crop produced an empty image", { crop });
    }
    const dipWidth = Math.max(1, Math.round(target.width / window.scaleFactor));
    const dipHeight = Math.max(1, Math.round(target.height / window.scaleFactor));
    let image = physicalImage.getSize().width === dipWidth && physicalImage.getSize().height === dipHeight
      ? physicalImage
      : physicalImage.resize({ width: dipWidth, height: dipHeight, quality: "best" });
    const dipSize = image.getSize();
    let imageScale = 1;
    if (dipSize.width > MAX_CAPTURE_EDGE || dipSize.height > MAX_CAPTURE_EDGE) {
      const factor = Math.min(MAX_CAPTURE_EDGE / dipSize.width, MAX_CAPTURE_EDGE / dipSize.height);
      const width = Math.max(1, Math.round(dipSize.width * factor));
      const height = Math.max(1, Math.round(dipSize.height * factor));
      image = image.resize({ width, height, quality: "best" });
      imageScale = dipSize.width / width;
    }
    if (image.isEmpty()) throw new WindowsAutomationError("CAPTURE_FAILED", "DIP-aligned window image is empty", { dipWidth, dipHeight });
    const imageSize = image.getSize();
    return {
      screenshot: image.toJPEG(CAPTURE_JPEG_QUALITY),
      details: {
        displayId: String(display.id),
        scaleFactor: display.scaleFactor,
        captureRectDip: { x: electronDipRect.x, y: electronDipRect.y, width: dipWidth, height: dipHeight },
        captureRectPhysical: target,
        captureMode: "foreground-display-crop",
        coordinateSpace: clientOnly ? "client-dip-aligned-pixels" : "window-dip-aligned-pixels",
        mimeType: "image/jpeg",
        imageScale: Math.round(imageScale * 10_000) / 10_000,
        imageSize,
      },
    };
  }

  private assertDisplayMatchesMonitor(
    display: Display,
    monitorRect: Rect,
    screen: typeof import("electron").screen,
  ): void {
    const physical = screen.dipToScreenRect(null, display.bounds);
    const close = (left: number, right: number): boolean => Math.abs(left - right) <= 2;
    // Electron's DIP round trip can differ by one physical pixel at fractional
    // scale factors; tolerate only that rounding, never a different monitor.
    const sameBounds = close(physical.x, monitorRect.left)
      && close(physical.y, monitorRect.top)
      && close(physical.width, monitorRect.width)
      && close(physical.height, monitorRect.height);
    if (!sameBounds) {
      throw new WindowsAutomationError("CAPTURE_FAILED", "Electron display identity does not match the target monitor", {
        displayId: String(display.id), physical, monitorRect,
      });
    }
  }
}

export const windowCaptureService = new WindowCaptureService();
