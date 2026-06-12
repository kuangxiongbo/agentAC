#import "edge_menubar.h"

#import <Cocoa/Cocoa.h>
#import <stdio.h>
#import <string.h>

static NSStatusItem *g_item = nil;
static NSMenu *g_popup_menu = nil;
static edge_menubar_action_fn g_handler = NULL;

@interface EdgeMenubarDelegate : NSObject
@end

@implementation EdgeMenubarDelegate

- (void)menuAction:(NSMenuItem *)sender {
  if (!g_handler || !sender.identifier) {
    return;
  }
  const char *cid = sender.identifier.UTF8String;
  if (cid) {
    g_handler(cid);
  }
}

- (void)edgeStatusClick:(id)sender {
  (void)sender;
  NSEvent *event = NSApp.currentEvent;
  if (event && (event.type == NSEventTypeRightMouseDown || event.type == NSEventTypeRightMouseUp)) {
    if (g_popup_menu && g_item) {
      [NSMenu popUpContextMenu:g_popup_menu withEvent:event forView:g_item.button];
    }
    return;
  }
  if (g_handler) {
    g_handler("tray_click");
  }
}

@end

static EdgeMenubarDelegate *g_delegate = nil;

static void edge_set_status_item_visible(NSStatusItem *item, BOOL visible) {
  if ([item respondsToSelector:@selector(setVisible:)]) {
    item.visible = visible;
  }
}

static void edge_set_status_item_behavior_default(NSStatusItem *item) {
  if ([item respondsToSelector:@selector(setBehavior:)]) {
    item.behavior = (NSStatusItemBehavior)0;
  }
}

static NSMenu *edge_build_menu(void) {
  NSMenu *menu = [[NSMenu alloc] initWithTitle:@"E-Agent Edge"];
  EdgeMenubarDelegate *delegate = g_delegate;

  NSArray<NSArray *> *rows = @[
    @[ @"open_local", @"打开 Web 控制台（本机）" ],
    @[ @"open_center", @"打开服务中心" ],
    @[ @"connection_setup", @"连接设置…" ],
    @[ @"__sep__", @"" ],
    @[ @"restart", @"重启边缘服务" ],
    @[ @"update", @"检查并更新 Runtime" ],
    @[ @"check_tray_update", @"检查托盘应用更新…" ],
    @[ @"__sep2__", @"" ],
    @[ @"quit", @"退出" ],
  ];

  for (NSArray *row in rows) {
    NSString *rid = row[0];
    NSString *title = row[1];
    if ([rid hasPrefix:@"__sep"]) {
      [menu addItem:[NSMenuItem separatorItem]];
      continue;
    }
    NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:title
                                                  action:@selector(menuAction:)
                                           keyEquivalent:@""];
    item.target = delegate;
    item.identifier = rid;
    [menu addItem:item];
  }
  return menu;
}

static NSImage *edge_image_from_rgba(const uint8_t *rgba, size_t len, uint32_t w, uint32_t h,
                                     bool as_template) {
  if (!rgba || w == 0 || h == 0 || len < (size_t)w * h * 4) {
    return nil;
  }
  NSBitmapImageRep *rep =
      [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL
                                              pixelsWide:(NSInteger)w
                                              pixelsHigh:(NSInteger)h
                                           bitsPerSample:8
                                         samplesPerPixel:4
                                                hasAlpha:YES
                                                isPlanar:NO
                                          colorSpaceName:NSCalibratedRGBColorSpace
                                            bytesPerRow:w * 4
                                               bitsPerPixel:32];
  if (!rep) {
    return nil;
  }
  memcpy([rep bitmapData], rgba, (size_t)w * h * 4);
  NSImage *img = [[NSImage alloc] initWithSize:NSMakeSize(18, 18)];
  [img addRepresentation:rep];
  [img setTemplate:as_template];
  return img;
}

static BOOL edge_screen_rect_in_menu_bar(NSRect screen, NSScreen *screenObj) {
  if (!screenObj) {
    return NO;
  }
  NSRect frame = screenObj.frame;
  CGFloat screenTop = frame.origin.y + frame.size.height;
  /* 刘海屏实际菜单栏常 > statusBar.thickness（22）；919 在 956 屏上即顶部 37pt 内 */
  CGFloat menuFloor = screenTop - 48.0;
  CGFloat rectTop = screen.origin.y + screen.size.height;
  return rectTop >= menuFloor - 2.0 && screen.origin.y <= screenTop + 2.0;
}

static void edge_install_on_main(const uint8_t *rgba, size_t len, uint32_t w, uint32_t h,
                                 bool as_template) {
  if (!g_delegate) {
    g_delegate = [[EdgeMenubarDelegate alloc] init];
  }

  if (!g_item) {
    g_item = [[NSStatusBar systemStatusBar] statusItemWithLength:22.0];
    edge_set_status_item_behavior_default(g_item);
    g_popup_menu = edge_build_menu();
    g_item.menu = nil;
    g_item.button.toolTip = @"E-Agent Edge — 点击打开连接配置";
    g_item.button.imagePosition = NSImageOnly;
    g_item.button.target = g_delegate;
    g_item.button.action = @selector(edgeStatusClick:);
  }

  NSImage *img = edge_image_from_rgba(rgba, len, w, h, as_template);
  if (img) {
    g_item.button.image = img;
  }
  edge_set_status_item_visible(g_item, YES);
  g_item.button.hidden = NO;
  g_item.button.alphaValue = 1.0;
  [g_item.button setNeedsDisplay:YES];
}

void edge_menubar_set_action_handler(edge_menubar_action_fn handler) { g_handler = handler; }

void edge_menubar_install_png(const uint8_t *rgba, size_t len, uint32_t width, uint32_t height,
                              bool as_template) {
  if ([NSThread isMainThread]) {
    edge_install_on_main(rgba, len, width, height, as_template);
    return;
  }
  dispatch_sync(dispatch_get_main_queue(), ^{
    edge_install_on_main(rgba, len, width, height, as_template);
  });
}

void edge_menubar_refresh_visible(void) {
  void (^block)(void) = ^{
    if (!g_item) {
      return;
    }
    edge_set_status_item_visible(g_item, YES);
    g_item.button.hidden = NO;
    g_item.button.alphaValue = 1.0;
    [g_item.button setNeedsDisplay:YES];
  };
  if ([NSThread isMainThread]) {
    block();
  } else {
    dispatch_async(dispatch_get_main_queue(), block);
  }
}

void edge_menubar_log_geometry(char *buf, size_t buflen) {
  if (!buf || buflen == 0) {
    return;
  }
  buf[0] = '\0';
  if (!g_item) {
    snprintf(buf, buflen, "objc_tray: no status item");
    return;
  }

  NSStatusBarButton *button = g_item.button;
  NSWindow *win = button.window;
  NSRect btn = button.frame;
  NSScreen *main = [NSScreen mainScreen];
  BOOL inBar = NO;
  BOOL visible = [g_item respondsToSelector:@selector(isVisible)] ? g_item.visible : YES;

  if (win) {
    NSRect screen = [win convertRectToScreen:btn];
    inBar = edge_screen_rect_in_menu_bar(screen, main);
    NSRect frame = main ? main.frame : NSZeroRect;
    snprintf(buf, buflen,
             "objc_tray visible=%d hidden=%d alpha=%.2f inMenuBar=%d "
             "btn=(%.0f,%.0f,%.0fx%.0f) screen=(%.0f,%.0f,%.0fx%.0f) "
             "mainScreen=(%.0f,%.0f,%.0fx%.0f) menuBarH=%.0f hasImage=%d",
             visible ? 1 : 0, button.hidden ? 1 : 0, button.alphaValue, inBar ? 1 : 0,
             btn.origin.x, btn.origin.y, btn.size.width, btn.size.height, screen.origin.x,
             screen.origin.y, screen.size.width, screen.size.height, frame.origin.x,
             frame.origin.y, frame.size.width, frame.size.height,
             NSStatusBar.systemStatusBar.thickness, button.image != nil ? 1 : 0);
  } else {
    snprintf(buf, buflen,
             "objc_tray visible=%d hidden=%d no-window btn=(%.0f,%.0f,%.0fx%.0f) hasImage=%d",
             visible ? 1 : 0, button.hidden ? 1 : 0, btn.origin.x, btn.origin.y,
             btn.size.width, btn.size.height, button.image != nil ? 1 : 0);
  }
}

void edge_menubar_log_environment(char *buf, size_t buflen) {
  if (!buf || buflen == 0) {
    return;
  }
  buf[0] = '\0';
  NSBundle *bundle = [NSBundle mainBundle];
  NSString *bid = bundle.bundleIdentifier ?: @"(nil)";
  NSString *path = bundle.bundlePath ?: @"(nil)";
  BOOL inApp = [path hasSuffix:@".app"] || [path containsString:@".app/"];
  NSScreen *main = [NSScreen mainScreen];
  NSRect frame = main ? main.frame : NSZeroRect;
  NSString *name = [[NSProcessInfo processInfo] processName];
  snprintf(buf, buflen,
           "env bundle=%s inApp=%d process=%s mainScreen=(%.0f,%.0f,%.0fx%.0f) statusBarH=%.0f",
           bid.UTF8String, inApp ? 1 : 0, name.UTF8String, frame.origin.x, frame.origin.y,
           frame.size.width, frame.size.height, NSStatusBar.systemStatusBar.thickness);
}
