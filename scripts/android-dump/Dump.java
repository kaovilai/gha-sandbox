// Idle-free accessibility-tree dump for the mobile live scenarios (see scripts/android-dump.sh).
//
// `uiautomator dump` calls UiAutomation.waitForIdle(1000, 10000) and gives up ("could not get idle state") when
// accessibility events keep arriving every <1 s (a running thread: "Working Ns" timer, streaming text, spinner).
// Nothing in getRootInActiveWindow() needs idle, so this connects UiAutomation exactly like uiautomator does,
// never waits for idle, and prints the same XML shape (text, content-desc, bounds) that scripts/uia.mjs parses.
//
// Run on device: CLASSPATH=dump.jar:/system/framework/uiautomator.jar app_process / Dump [--compressed]
// Exit codes: 0 ok (XML on stdout), 2 no root window, 3 could not connect UiAutomation.
import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.UiAutomation;
import android.graphics.Rect;
import android.os.HandlerThread;
import android.os.Looper;
import android.view.accessibility.AccessibilityNodeInfo;
import java.lang.reflect.Constructor;
import java.lang.reflect.Method;

public class Dump {
  static Object wrapper; // com.android.uiautomator.core.UiAutomationShellWrapper when available
  static HandlerThread ht;

  static UiAutomation connect() throws Exception {
    // 1. the same helper `uiautomator dump` uses (lives in /system/framework/uiautomator.jar)
    try {
      Class<?> w = Class.forName("com.android.uiautomator.core.UiAutomationShellWrapper");
      wrapper = w.getDeclaredConstructor().newInstance();
      w.getMethod("connect").invoke(wrapper);
      return (UiAutomation) w.getMethod("getUiAutomation").invoke(wrapper);
    } catch (Throwable t) {
      System.err.println("wrapper path failed: " + t + " (cause " + t.getCause() + "); trying direct UiAutomation");
      wrapper = null;
    }
    // 2. what the wrapper does itself: new UiAutomation(looper, new UiAutomationConnection()).connect()
    ht = new HandlerThread("DumpHandlerThread");
    ht.start();
    Class<?> connCls = Class.forName("android.app.UiAutomationConnection");
    Object conn = connCls.getDeclaredConstructor().newInstance();
    Class<?> iconn = Class.forName("android.app.IUiAutomationConnection");
    UiAutomation ua = null;
    for (Constructor<?> c : UiAutomation.class.getDeclaredConstructors()) {
      Class<?>[] p = c.getParameterTypes();
      if (p.length == 2 && p[0] == Looper.class && p[1] == iconn) {
        c.setAccessible(true);
        ua = (UiAutomation) c.newInstance(ht.getLooper(), conn);
      }
    }
    if (ua == null) throw new IllegalStateException("no UiAutomation(Looper, IUiAutomationConnection) constructor");
    Method m = UiAutomation.class.getDeclaredMethod("connect");
    m.setAccessible(true);
    m.invoke(ua);
    return ua;
  }

  static void esc(StringBuilder sb, CharSequence s) {
    if (s == null) return;
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      switch (c) {
        case '&': sb.append("&amp;"); break;
        case '<': sb.append("&lt;"); break;
        case '>': sb.append("&gt;"); break;
        case '"': sb.append("&quot;"); break;
        case '\n': sb.append("&#10;"); break;
        case '\r': case '\t': sb.append(' '); break;
        default: if (c >= 0x20) sb.append(c);
      }
    }
  }

  static int nodes = 0;

  static void walk(AccessibilityNodeInfo n, StringBuilder sb, int depth) {
    if (n == null || depth > 80) return;
    if (!n.isVisibleToUser()) return; // same filter as uiautomator's dumper: off-screen text is not proof
    Rect r = new Rect();
    n.getBoundsInScreen(r);
    nodes++;
    sb.append("<node index=\"").append(nodes).append("\" text=\"");
    esc(sb, n.getText());
    sb.append("\" resource-id=\"");
    esc(sb, n.getViewIdResourceName());
    sb.append("\" class=\"");
    esc(sb, n.getClassName());
    sb.append("\" package=\"");
    esc(sb, n.getPackageName());
    sb.append("\" content-desc=\"");
    esc(sb, n.getContentDescription());
    sb.append("\" clickable=\"").append(n.isClickable());
    sb.append("\" enabled=\"").append(n.isEnabled());
    sb.append("\" bounds=\"[").append(r.left).append(',').append(r.top).append("][").append(r.right).append(',').append(r.bottom).append("]\">");
    int cc = n.getChildCount();
    for (int i = 0; i < cc; i++) {
      AccessibilityNodeInfo ch = null;
      try { ch = n.getChild(i); } catch (Throwable ignored) {}
      walk(ch, sb, depth + 1);
    }
    sb.append("</node>");
  }

  public static void main(String[] args) throws Exception {
    boolean compressed = args.length > 0 && args[0].equals("--compressed");
    int rc = 0;
    UiAutomation ua = null;
    try {
      ua = connect();
    } catch (Throwable t) {
      System.err.println("connect failed: " + t + " cause=" + t.getCause());
      System.exit(3);
    }
    try {
      AccessibilityServiceInfo info = ua.getServiceInfo();
      if (info != null) {
        if (compressed) info.flags &= ~AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS;
        else info.flags |= AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS;
        ua.setServiceInfo(info);
      }
      // right after connect the active window can be null for a moment; never wait for idle, just retry briefly
      AccessibilityNodeInfo root = null;
      for (int i = 0; i < 25 && root == null; i++) {
        root = ua.getRootInActiveWindow();
        if (root == null) Thread.sleep(200);
      }
      if (root == null) {
        System.err.println("no active window root");
        rc = 2;
      } else {
        StringBuilder sb = new StringBuilder("<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation=\"0\">");
        walk(root, sb, 0);
        sb.append("</hierarchy>");
        System.out.println(sb);
        System.err.println("nodes=" + nodes);
      }
    } catch (Throwable t) {
      System.err.println("dump failed: " + t);
      rc = 3;
    } finally {
      try {
        if (wrapper != null) wrapper.getClass().getMethod("disconnect").invoke(wrapper);
        else if (ua != null) {
          Method d = UiAutomation.class.getDeclaredMethod("disconnect");
          d.setAccessible(true);
          d.invoke(ua);
        }
      } catch (Throwable ignored) {}
    }
    System.out.flush();
    System.exit(rc);
  }
}
