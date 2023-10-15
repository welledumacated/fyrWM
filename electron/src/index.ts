import { app, BrowserWindow, globalShortcut, ipcMain } from "electron";
import { spawn } from "child_process";
import { XDisplay, createClient } from "x11";
import ini from "ini";
import fs from "fs";
import path, { join } from "path";
import { FyrConfig, FyrWindow, SplitDirection } from "./types/FyrTypes";
import { logToFile, LogLevel, homedir, exec } from "./lib/utils";
import { defaultFyrConfig } from "./lib/config";
import {
  IX11Client,
  IX11Mod,
  IXClient,
  IXEvent,
  IXScreen,
  X11_EVENT_TYPE,
} from "./types/X11Types";
const x11: IX11Mod = require("x11");
const wmLogFilePath = join(homedir(), ".fyr", "logs", "wm.log");

// x11
let X: IXClient;
let client: IX11Client;
let root: number;
let screen: IXScreen = null;

// Switched with Super + V or Super + H, determines window split
let splitDirection = SplitDirection.Horizontal;

let launcherWid: number = null;
let launcherWindow: BrowserWindow = null;
let launcherInited: boolean = false;

// Used by compositor
let wmClassAtom;
let stringAtom;

// Track all open x11 windows
const openedWindows: Set<number> = new Set();
const allOpenedFyrWindows: Set<FyrWindow> = new Set();
let currentWindowId: number | null = null;
let currentResizableWindow: FyrWindow = null;

// Get user settings. Called immediately
const config: FyrConfig = (() => {
  const homeDir = process.env.HOME;
  if (!homeDir) {
    throw new Error("HOME directory is not set.");
  }
  const configPath = path.join(homeDir, ".fyr/wm/config.json");

  try {
    const rawData = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(rawData);
  } catch (err) {
    const dirPath = path.dirname(configPath);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }

    // Write the default config to the file if failure to read config
    fs.writeFileSync(
      configPath,
      JSON.stringify(defaultFyrConfig, null, 2),
      "utf-8"
    );

    return defaultFyrConfig;
  }
})();

// Depends on feh package
const setWallpaper = () => {
  const wallpaperPath = config.customizations.wallpaperPath;
  const command = `feh --bg-scale ${wallpaperPath}`;

  exec(command, (error) => {
    if (error) {
    } else {
      logToFile(wmLogFilePath, "Failed to set wallpaper", LogLevel.ERROR);
    }
  });
};

// Gets rid of X cursor when mouse is over desktop root
const setXRootCursor = (): void => {
  const command = `xsetroot -cursor_name arrow`;
  exec(command, (err) => {
    logToFile(wmLogFilePath, "Failed to set cursor", LogLevel.ERROR);
  });
};

// Needs picom installed, set window class to electronTransparent for a fully transparent window.
const initCompositing = (): void => {
  const command = `picom -b --config ~/.config/picom/picom.conf`;
  exec(command, (err) => {
    logToFile(
      wmLogFilePath,
      "Failed to initialize compositor" + err,
      LogLevel.ERROR
    );
  });
};

const initDesktop = async (display: XDisplay): Promise<number> => {
  screen = display.screen[0];
  root = screen.root;
  X.MapWindow(root);
  setWallpaper();
  setXRootCursor();
  return root;
};

// Everything depends on this
const setCurrentResizableWindow = (
  windowId: number,
  width: number,
  height: number,
  x: number,
  y: number,
  horizontalParentId: number,
  verticalParentId: number,
  horizontalChildId,
  verticalChildId,
  lastSplitType: SplitDirection
) => {
  if (windowId === launcherWid) return;

  if (!isTopLevelApplication(windowId)) return;

  currentResizableWindow = {
    windowId,
    width,
    height,
    x,
    y,
    horizontalParentId,
    verticalParentId,
    horizontalChildId,
    verticalChildId,
    lastSplitType,
  };
};

const findFyrWindow = (wid: number): FyrWindow => {
  let foundWindow: FyrWindow = null;
  allOpenedFyrWindows.forEach((win) => {
    if (win.windowId === wid) {
      foundWindow = win;
    }
  });
  return foundWindow;
};

// Redundantly remove item just in case
const addFyrWind = (fyrWin: FyrWindow) => {
  if (fyrWin.windowId === launcherWid) return;
  allOpenedFyrWindows.forEach((win) => {
    if (win.windowId === fyrWin.windowId) {
      allOpenedFyrWindows.delete(win);
    }
  });
  allOpenedFyrWindows.add(fyrWin);
};

// Verifies that item should have tiling logic applied
const isTopLevelApplication = async (windowId: number): Promise<boolean> => {
  return new Promise((resolve, reject) => {
    X.QueryTree(windowId, (err, tree) => {
      if (err) {
        reject(err);
        return;
      }
      if (tree.parent === root) {
        X.GetWindowAttributes(windowId, (err, attrs) => {
          if (err) {
            reject(err);
            return;
          }
          if (!attrs.overrideRedirect) {
            resolve(true);
          } else {
            resolve(false);
          }
        });
      } else {
        resolve(false);
      }
    });
  });
};

// Handles map requests and determines size of tiles
const openApp = async (
  appWid: number,
  splitDirection: number,
  currentWindowId?: number
): Promise<void> => {
  if (launcherWid === appWid) {
    X.MapWindow(appWid);
    return;
  }

  const shouldRender = await isTopLevelApplication(appWid);

  if (!shouldRender) return;

  if (!openedWindows.has(appWid)) openedWindows.add(appWid);

  if (openedWindows.size === 1) {
    // Gap
    X.ResizeWindow(appWid, screen.pixel_width - 10, screen.pixel_height - 10);
    // X.ReparentWindow(appWid, root, 5, 5);
    X.MoveWindow(appWid, 5, 5);
    X.MapWindow(appWid);
    X.ChangeWindowAttributes(
      appWid,
      {
        eventMask:
          x11.eventMask.StructureNotify |
          x11.eventMask.EnterWindow |
          x11.eventMask.LeaveWindow |
          x11.eventMask.KeyPress |
          x11.eventMask.KeyRelease |
          x11.eventMask.FocusChange |
          x11.eventMask.Exposure,
      },
      (err) => {
        logToFile(wmLogFilePath, JSON.stringify(err), LogLevel.ERROR);
      }
    );
    // X.SetInputFocus(appWid, XFocusRevertTo.PointerRoot);
    setCurrentResizableWindow(
      appWid,
      screen.pixel_width - 10,
      screen.pixel_height - 10,
      5,
      5,
      null,
      null,
      null,
      null,
      null
    );

    // First window has no pair, will be updated on next app open
    addFyrWind({
      windowId: appWid,
      width: screen.pixel_width - 10,
      height: screen.pixel_height - 10,
      x: 5,
      y: 5,
      horizontalParentId: null,
      verticalParentId: null,
      horizontalChildId: null,
      verticalChildId: null,
      lastSplitType: null,
    });

    return;
  } else {
    if (
      splitDirection === SplitDirection.Horizontal &&
      currentResizableWindow
    ) {
      // If horizonal selected, cut current window in half
      const newWidth = (currentResizableWindow.width - 5) / 2;
      const newX = currentResizableWindow.x + newWidth + 5;
      X.ResizeWindow(
        currentResizableWindow.windowId,
        newWidth,
        currentResizableWindow.height
      );
      X.MapWindow(currentResizableWindow.windowId);

      // Resize incoming window and map window
      X.ResizeWindow(appWid, newWidth, currentResizableWindow.height);
      X.MoveWindow(appWid, newX, currentResizableWindow.y);
      X.MapWindow(appWid);

      if (currentResizableWindow.horizontalChildId) {
        const newChild = findFyrWindow(
          currentResizableWindow.horizontalChildId
        );
        addFyrWind({
          ...newChild,
          horizontalParentId: appWid,
        });
      }

      // Track new window with "parent" window id
      addFyrWind({
        windowId: appWid,
        width: newWidth,
        height: currentResizableWindow.height,
        x: newX,
        y: currentResizableWindow.y,
        horizontalParentId: currentResizableWindow.windowId,
        verticalParentId: null,
        horizontalChildId: currentResizableWindow.horizontalChildId
          ? currentResizableWindow.horizontalChildId
          : null,
        verticalChildId: null,
        lastSplitType: null,
      });

      // Modify existing window
      addFyrWind({
        ...currentResizableWindow,
        width: newWidth,
        // Last split type tracked in parent for resizing children on destroy
        lastSplitType: SplitDirection.Horizontal,
        horizontalChildId: appWid,
      });

      X.ChangeWindowAttributes(
        appWid,
        {
          eventMask:
            x11.eventMask.StructureNotify |
            x11.eventMask.EnterWindow |
            x11.eventMask.LeaveWindow |
            x11.eventMask.KeyPress |
            x11.eventMask.KeyRelease |
            x11.eventMask.FocusChange |
            x11.eventMask.Exposure,
        },
        (err) => {
          logToFile(wmLogFilePath, JSON.stringify(err), LogLevel.ERROR);
        }
      );

      setCurrentResizableWindow(
        appWid,
        newWidth,
        currentResizableWindow.height,
        newX,
        currentResizableWindow.y,
        currentResizableWindow.windowId,
        null,
        null,
        null,
        null
      );

      return;
    } else if (splitDirection === SplitDirection.Vertical) {
      // Cut in half
      const newHeight = (currentResizableWindow.height - 5) / 2;
      const newY = currentResizableWindow.y + newHeight + 5;
      X.ResizeWindow(
        currentResizableWindow.windowId,
        currentResizableWindow.width,
        newHeight
      );
      X.MapWindow(currentResizableWindow.windowId);

      // Resize incoming window and map window
      X.ResizeWindow(appWid, currentResizableWindow.width, newHeight);
      X.MoveWindow(appWid, currentResizableWindow.x, newY);
      X.MapWindow(appWid);

      if (currentResizableWindow.verticalChildId) {
        const newChild = findFyrWindow(currentResizableWindow.verticalChildId);
        addFyrWind({
          ...newChild,
          horizontalParentId: appWid,
        });
      }

      // Track new window
      addFyrWind({
        windowId: appWid,
        width: currentResizableWindow.width,
        height: newHeight,
        x: currentResizableWindow.x,
        y: newY,
        verticalParentId: currentResizableWindow.windowId,
        horizontalParentId: null,
        horizontalChildId: null,
        verticalChildId: null,
        lastSplitType: null,
      });

      // Modify existing window
      addFyrWind({
        ...currentResizableWindow,
        height: newHeight,
        lastSplitType: SplitDirection.Vertical,
        verticalChildId: appWid,
      });

      X.ChangeWindowAttributes(
        appWid,
        {
          eventMask:
            x11.eventMask.StructureNotify |
            x11.eventMask.EnterWindow |
            x11.eventMask.LeaveWindow |
            x11.eventMask.KeyPress |
            x11.eventMask.KeyRelease |
            x11.eventMask.FocusChange |
            x11.eventMask.Exposure,
        },
        (err) => {
          logToFile(wmLogFilePath, JSON.stringify(err), LogLevel.ERROR);
        }
      );

      // Update current selected window for next resize
      setCurrentResizableWindow(
        appWid,
        currentResizableWindow.width,
        newHeight,
        currentResizableWindow.x,
        newY,
        null,
        currentResizableWindow.windowId,
        null,
        null,
        null
      );
      return;
    }
    X.MapWindow(appWid);
    return;
  }
};

/*
  One side for windows with children will always match perfectly to 
  the children's sum w/h due to constraints so we need to find which 
  child(ren) matches the best and track them
*/
const findBestChildrenMatch = (
  parentWindow: FyrWindow
): [Array<FyrWindow>, SplitDirection] => {
  let vertChildrenWidth = 0;
  let vertChildren: Array<FyrWindow> = [];

  let horizChildrenHeight = 0;
  let horizChildren: Array<FyrWindow> = [];

  for (const win of Array.from(allOpenedFyrWindows)) {
    // First check for direct children with similar dimensions, easiest route
    if (
      win.windowId === parentWindow.horizontalChildId &&
      win.y === parentWindow.y &&
      win.height === parentWindow.height
    ) {
      logToFile(wmLogFilePath, "HORIZ DIRECT CHILD", LogLevel.DEBUG);
      return [[win], SplitDirection.Horizontal];
    } else if (
      win.windowId === parentWindow.verticalChildId &&
      win.x === parentWindow.x &&
      win.width === parentWindow.width
    ) {
      logToFile(wmLogFilePath, "VERT DIRECT CHILD", LogLevel.DEBUG);
      return [[win], SplitDirection.Vertical];
    }

    // If there's a failure in finding an exact child match, find all bordering children

    // Children sharing a vertical border
    if (
      win.y === parentWindow.y + parentWindow.height + 5 ||
      win.y === parentWindow.y + parentWindow.height
    ) {
      // If within the parents width:
      if (
        win.x >= parentWindow.x &&
        win.x + win.width <= parentWindow.x + parentWindow.width + 5
      ) {
        // Add widths and track children in case this side matches, account for margin
        vertChildrenWidth += win.width;
        vertChildren = vertChildren.concat([win]);
        if (vertChildren.length >= 2) {
          vertChildrenWidth += 5;
        }
      }
    }

    //Sharing a horizontal border
    if (
      win.x === parentWindow.x + parentWindow.width + 5 ||
      win.x === parentWindow.x + parentWindow.width
    ) {
      if (
        win.y >= parentWindow.y &&
        win.y + win.height <= parentWindow.height + parentWindow.y + 10
      ) {
        horizChildrenHeight += win.height;
        horizChildren = horizChildren.concat([win]);
        if (horizChildren.length >= 2) {
          horizChildrenHeight += 5;
        }
      }
    }
  }

  if (vertChildrenWidth === parentWindow.width) {
    return [vertChildren, SplitDirection.Vertical];
  } else if (horizChildrenHeight === parentWindow.height) {
    return [horizChildren, SplitDirection.Horizontal];
  } else {
    return [[], null];
  }
};

// Same as children, one parenting side should match perfectly.
const findBestParentMatch = (
  childWindow: FyrWindow
): [Array<FyrWindow>, SplitDirection] => {
  let vertParentWidth = 0;
  let vertParents: Array<FyrWindow> = [];
  let horizParentHeight = 0;
  let horizParents: Array<FyrWindow> = [];

  allOpenedFyrWindows.forEach((parentWindow) => {
    // First look for direct parent exact matches
    if (parentWindow.windowId === childWindow.horizontalParentId) {
      return [[parentWindow], SplitDirection.Horizontal];
    }
    if (parentWindow.windowId === childWindow.verticalParentId) {
      return [[parentWindow], SplitDirection.Vertical];
    }

    // Find adjacent parent windows if not successful
    if (parentWindow.windowId !== childWindow.windowId) {
      // Look for direct matches first
      if (
        parentWindow.height === childWindow.height &&
        parentWindow.x + parentWindow.width + 5 === childWindow.x
      ) {
        return [[parentWindow], SplitDirection.Horizontal];
      }

      if (
        parentWindow.width === childWindow.width &&
        parentWindow.y + parentWindow.height + 5 === childWindow.y
      ) {
        return [[parentWindow], SplitDirection.Horizontal];
      }

      // If no direct match, do the maths
      if (parentWindow.y + parentWindow.height + 5 === childWindow.y) {
        // Parents sharing a vertical border
        if (
          parentWindow.x + parentWindow.width >= childWindow.x &&
          parentWindow.x + parentWindow.width <=
            childWindow.x + childWindow.width
        ) {
          vertParentWidth += parentWindow.width;
          vertParents = vertParents.concat([parentWindow]);
        }
      }

      if (parentWindow.x + parentWindow.width + 5 === childWindow.x) {
        if (
          parentWindow.y + parentWindow.height >= childWindow.y &&
          parentWindow.y + parentWindow.height <=
            childWindow.y + childWindow.height
        ) {
          horizParentHeight += parentWindow.height;
          horizParents = horizParents.concat([parentWindow]);
        }
      }
    }
  });

  logToFile(wmLogFilePath, JSON.stringify(vertParentWidth), LogLevel.DEBUG);
  logToFile(wmLogFilePath, JSON.stringify(childWindow), LogLevel.DEBUG);

  if (vertParentWidth === childWindow.width) {
    return [vertParents, SplitDirection.Vertical];
  } else if (horizParentHeight === childWindow.height) {
    return [horizParents, SplitDirection.Horizontal];
  } else {
    logToFile(wmLogFilePath, "COULDNT RESIZE PARENTS", LogLevel.INFO);
    return [[], null];
  }
};

const resizeRepositionReparentChildren = (
  parent: FyrWindow,
  children: Array<FyrWindow>,
  splitType: SplitDirection
): void => {
  let immediateVertChild: FyrWindow;
  let immediateHorzChild: FyrWindow;
  children.forEach((childWindow) => {
    // Get immediate child for reparenting
    if (parent.verticalChildId === childWindow.windowId) {
      immediateVertChild = childWindow;
    }

    if (parent.horizontalChildId === childWindow.windowId) {
      immediateHorzChild = childWindow;
    }

    if (splitType === SplitDirection.Horizontal) {
      const [width, height]: [number, number] = [
        childWindow.width + parent.width + 5,
        childWindow.height,
      ];
      const [x, y]: [number, number] = [parent.x, childWindow.y];
      addFyrWind({
        ...childWindow,
        width,
        x: parent.x,
      });
      X.ResizeWindow(childWindow.windowId, width, height);
      X.MoveWindow(childWindow.windowId, x, y);
    } else if (splitType === SplitDirection.Vertical) {
      const [width, height]: [number, number] = [
        childWindow.width,
        childWindow.height + parent.height + 5,
      ];
      const [x, y]: [number, number] = [childWindow.x, parent.y];
      addFyrWind({
        ...childWindow,
        height,
        y: parent.y,
      });
      X.ResizeWindow(childWindow.windowId, width, height);
      X.MoveWindow(childWindow.windowId, x, y);
    }
  });

  if (immediateHorzChild?.horizontalParentId === parent.windowId) {
    addFyrWind({
      ...immediateHorzChild,
      x: parent.x,
      width: immediateHorzChild.width + parent.width + 5,
      verticalParentId: parent.verticalParentId,
      horizontalParentId: parent.horizontalParentId,
    });
  } else if (immediateVertChild?.verticalParentId === parent.windowId) {
    addFyrWind({
      ...immediateVertChild,
      y: parent.y,
      height: immediateVertChild.height + parent.height + 5,
      verticalParentId: parent.verticalParentId,
      horizontalParentId: parent.horizontalParentId,
    });
  }

  // Update parent's with new child Id's
  const horizontalParent = findFyrWindow(parent.horizontalParentId);
  const verticalParent = findFyrWindow(parent.verticalParentId);

  if (horizontalParent) {
    addFyrWind({
      ...horizontalParent,
      horizontalChildId: immediateHorzChild.windowId,
    });
  }
  if (verticalParent) {
    addFyrWind({
      ...verticalParent,
      verticalChildId: immediateVertChild.windowId,
    });
  }
};

const resizeRepositionRechildParents = (
  childWindow: FyrWindow,
  parents: Array<FyrWindow>,
  splitType: SplitDirection
): void => {
  let immediateHorzParent: FyrWindow;
  let immediateVertParent: FyrWindow;
  let width: number;
  let height: number;
  parents.forEach((parentWindow) => {
    if (parentWindow.horizontalChildId === childWindow.windowId) {
      immediateHorzParent = parentWindow;
    }

    if (parentWindow.verticalChildId === childWindow.windowId) {
      immediateVertParent = parentWindow;
    }

    if (splitType === SplitDirection.Horizontal) {
      width = parentWindow.width + childWindow.width + 5;
      addFyrWind({
        ...parentWindow,
        width,
      });
      X.ResizeWindow(parentWindow.windowId, width, parentWindow.height);
    } else if (splitType === SplitDirection.Vertical) {
      height = parentWindow.height + childWindow.height + 5;
      addFyrWind({
        ...parentWindow,
        height,
      });
      X.ResizeWindow(parentWindow.windowId, parentWindow.width, height);
    }
  });

  // Assign new grandchildren windows
  if (immediateHorzParent && splitType === SplitDirection.Horizontal) {
    addFyrWind({
      ...immediateHorzParent,
      horizontalChildId: childWindow.horizontalChildId,
      width,
    });
  } else if (immediateVertParent && splitType === SplitDirection.Vertical) {
    addFyrWind({
      ...immediateVertParent,
      verticalChildId: childWindow.verticalChildId,
      height,
    });
  }
};

const resizeOnDestroy = (deletedWindow: FyrWindow): void => {
  if (deletedWindow) {
    const [childrenToResize, childSplitType] =
      findBestChildrenMatch(deletedWindow);
    if (childrenToResize?.length > 0) {
      resizeRepositionReparentChildren(
        deletedWindow,
        childrenToResize,
        childSplitType
      );
      return;
    }
  }

  if (deletedWindow.horizontalParentId || deletedWindow.verticalParentId) {
    const [parentsToResize, parentSpltType] =
      findBestParentMatch(deletedWindow);
    if (parentsToResize?.length > 0) {
      resizeRepositionRechildParents(
        deletedWindow,
        parentsToResize,
        parentSpltType
      );
      return;
    }
  } else {
    logToFile(wmLogFilePath, "ERROR RESIZING", LogLevel.ERROR);
  }

  return;
};

// Get window to delete and resize all windows
const handleDestroyNotify = (wid: number) => {
  const windowToDelete: FyrWindow = findFyrWindow(wid);
  if (windowToDelete) {
    if (openedWindows.has(wid)) {
      openedWindows.delete(wid);
      resizeOnDestroy(windowToDelete);
    }
  }
};

const initX11Client = async () => {
  client = await createClient(async (err, display: XDisplay) => {
    if (err) {
      logToFile(
        wmLogFilePath,
        `Error in X11 connection:${err}`,
        LogLevel.ERROR
      );
      return;
    }

    X = display.client;
    await initDesktop(display);

    X.InternAtom(false, "WM_CLASS", (err, atom) => {
      if (err) {
        console.error(err);
        return;
      }
      wmClassAtom = atom;
      X.InternAtom(false, "STRING", (err, atom) => {
        if (err) {
          console.error(err);
          return;
        }
        stringAtom = atom;
      });
    });

    X.ChangeWindowAttributes(
      root,
      {
        eventMask:
          x11.eventMask.SubstructureNotify |
          x11.eventMask.SubstructureRedirect |
          x11.eventMask.ButtonPress |
          x11.eventMask.ButtonRelease,
      },
      (err) => {
        logToFile(
          wmLogFilePath,
          "Couldn't change event mask :(",
          LogLevel.ERROR
        );
      }
    );

    // Capture keyboard, mouse, and window events
    client.on("event", async (ev: IXEvent) => {
      const { type } = ev;
      switch (type) {
        case X11_EVENT_TYPE.KeyPress:
          if (ev.wid === launcherWid) return;
          const focusedWindow =
            ev.wid && ev.wid !== launcherWid ? findFyrWindow(ev.wid) : null;
          currentWindowId =
            ev.wid && ev.wid !== launcherWid ? ev.wid : currentWindowId;
          currentResizableWindow =
            ev.wid !== launcherWid && focusedWindow
              ? focusedWindow
              : currentResizableWindow;
          break;
        case X11_EVENT_TYPE.KeyRelease:
          break;
        case X11_EVENT_TYPE.ButtonPress:
          break;
        case X11_EVENT_TYPE.ButtonRelease:
          break;
        case X11_EVENT_TYPE.MotionNotify:
          break;
        case X11_EVENT_TYPE.EnterNotify:
          break;
        case X11_EVENT_TYPE.LeaveNotify:
          break;
        case X11_EVENT_TYPE.Expose:
          break;
        case X11_EVENT_TYPE.CreateNotify:
          break;
        case X11_EVENT_TYPE.MapRequest:
          openApp(ev.wid, splitDirection, currentWindowId);
          currentWindowId = ev.wid !== launcherWid ? ev.wid : currentWindowId;
          break;
        case X11_EVENT_TYPE.DestroyNotify:
          handleDestroyNotify(ev.wid);
          if (currentWindowId === ev.wid) {
            if (openedWindows.size === 0) {
              currentWindowId = null;
              currentResizableWindow = null;
            } else {
              // Last opened or focused window
              currentWindowId = Array.from(openedWindows).pop() || null;
              currentResizableWindow = findFyrWindow(currentWindowId);
            }
          }
          break;
        case X11_EVENT_TYPE.UnmapNotify:
          break;
        case X11_EVENT_TYPE.MapNotify:
          break;
        case X11_EVENT_TYPE.MapRequest:
          break;
        case X11_EVENT_TYPE.ReparentNotify:
          break;
        case X11_EVENT_TYPE.ConfigureNotify:
          break;
        case X11_EVENT_TYPE.ConfigureRequest:
          break;
        case X11_EVENT_TYPE.ClientMessage:
          break;
        case X11_EVENT_TYPE.PropertyNotify:
          break;
        default:
          break;
      }
    });
  });
};

//---------------------------------------------- Electron----------------------------------------------------

const getElectronWindowId = (browserWindow: BrowserWindow): number => {
  const nativeHandle = browserWindow.getNativeWindowHandle();
  const wid = nativeHandle.readUint32LE(0);
  return wid;
};

app.whenReady().then(async () => {
  await initX11Client();
  initCompositing();
  const launcherShortcut = globalShortcut.register("Super+Space", () => {
    if (launcherWid && launcherWindow.isVisible()) {
      launcherWindow.hide();
    } else if (launcherInited) {
      launcherWindow.show();
      X.RaiseWindow(launcherWid);
    } else {
      openLauncher();
    }
  });
  if (!launcherShortcut) {
  }

  const closeAppShortcut = globalShortcut.register("Super+Q", () => {
    if (currentResizableWindow) {
      X.DestroyWindow(currentResizableWindow.windowId);
    }
  });
  if (!closeAppShortcut) {
  }

  // Exit wm
  const closeWMShortcut = globalShortcut.register("Ctrl+Shift+Q", () => {
    app.quit();
  });
  if (!closeWMShortcut) {
  }

  // Window split directions
  const horizontalSplitShortcut = globalShortcut.register("Super+H", () => {
    splitDirection = SplitDirection.Horizontal;
  });

  if (!horizontalSplitShortcut) {
  }

  try {
    const verticalSplitShortcut = globalShortcut.register("Super+V", () => {
      splitDirection = SplitDirection.Vertical;
    });

    if (!verticalSplitShortcut) {
    }
  } catch (err) {}

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) initX11Client();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
  }
});

ipcMain.on("onLaunchApp", (event, appCommand) => {
  const [command, ...args] = appCommand.split(" ");
  const child = spawn(command, args, {
    env: { ...process.env },
    shell: true,
  });
  launcherWindow.hide();

  child.on("error", (error) => {});

  child.on("exit", (code) => {
    if (code !== null) {
    }
  });
});

ipcMain.handle("getApps", async () => {
  const appPaths = ["/usr/share/applications"];

  const apps = [];

  for (const path of appPaths) {
    try {
      const files = fs.readdirSync(path);

      for (const file of files) {
        if (file.endsWith(".desktop")) {
          const filePath = `${path}/${file}`;
          const data = fs.readFileSync(filePath, "utf-8");
          const appConfig = ini.parse(data);

          const desktopEntry = appConfig["Desktop Entry"];
          if (desktopEntry && desktopEntry.Name && desktopEntry.Exec) {
            apps.push({
              name: desktopEntry.Name,
              exec: desktopEntry.Exec,
            });
          }
        }
      }
    } catch (err) {}
  }

  return apps;
});

const setWindowClass = (windowId, className) => {
  const value = Buffer.from(`${className}\0${className}\0`, "binary");

  X.ChangeProperty(0, windowId, wmClassAtom, stringAtom, 8, value);
};

const openLauncher = () => {
  const [width, height] = [screen.pixel_width, screen.pixel_height];

  const [x, y] = [0, 0];

  launcherWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    movable: false,
    focusable: true,
    skipTaskbar: true,
    backgroundColor: "#000000",
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  launcherWindow.webContents.loadFile("./dist/vue/app-launcher.html");

  launcherWindow.setFullScreen(true);
  launcherWindow.setFocusable(true);
  launcherWindow.setAlwaysOnTop(true);
  launcherWid = getElectronWindowId(launcherWindow);
  launcherInited = true;
  setWindowClass(launcherWid, "electronTransparent");
  X.RaiseWindow(launcherWid);
  X.MapWindow(launcherWid);
};
