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
  };
}

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
    const image = physicalImage.getSize().width === dipWidth && physicalImage.getSize().height === dipHeight
      ? physicalImage
      : physicalImage.resize({ width: dipWidth, height: dipHeight, quality: "best" });
    if (image.isEmpty()) throw new WindowsAutomationError("CAPTURE_FAILED", "DIP-aligned window image is empty", { dipWidth, dipHeight });
    return {
      screenshot: image.toPNG(),
      details: {
        displayId: String(display.id),
        scaleFactor: display.scaleFactor,
        captureRectDip: { x: electronDipRect.x, y: electronDipRect.y, width: dipWidth, height: dipHeight },
        captureRectPhysical: target,
        captureMode: "foreground-display-crop",
        coordinateSpace: clientOnly ? "client-dip-aligned-pixels" : "window-dip-aligned-pixels",
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
