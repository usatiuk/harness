"""Actual Linux native image-input regression (GTK3/WebKitGTK, Xvfb, XTest).

Prerequisites: default `cargo build` for desktop, owned/project Vite on port1420,
Python gi GTK3/GdkPixbuf, Xvfb, libXtst and dbus-run-session. Run from any directory:
  python3 packages/desktop/tests/native/linux-images.py

Uses an isolated display, session bus, clipboard, profile, fixture model and ports.
Inspector evaluations only observe/focus/navigate; paste/drop/chooser/send use OS
keyboard/mouse events. Timers pace pointer gestures; completion checks poll actual
preview counts and model output. Artifacts remain under /tmp for failure analysis.
"""
import os, subprocess, tempfile, pathlib, time, urllib.request, json, ctypes, ctypes.util, re, threading, http.server, socket, sys, atexit
repo = pathlib.Path(__file__).resolve().parents[4]
helper = pathlib.Path(__file__).with_name('linux-image-inspector.mjs')
if 'HARNESS_IMAGE_PROBE_ROOT' not in os.environ:
    root = pathlib.Path(tempfile.mkdtemp(prefix='harness-native-images-'))
    for name in ['config', 'data', 'cache', 'runtime']:
        (root / name).mkdir(mode=0o700)
    environment = dict(os.environ, HARNESS_IMAGE_PROBE_ROOT=str(root), XDG_CONFIG_HOME=str(root / 'config'), XDG_DATA_HOME=str(root / 'data'), XDG_CACHE_HOME=str(root / 'cache'), XDG_RUNTIME_DIR=str(root / 'runtime'))
    sys.exit(subprocess.call(['dbus-run-session', '--', sys.executable, __file__], env=environment))
root = pathlib.Path(os.environ['HARNESS_IMAGE_PROBE_ROOT'])
passed = False
cleaned = False
node = ['node', '--conditions=development', '--import=tsx', str(helper)]

def cleanup():
    global cleaned, passed
    if cleaned:
        return
    cleaned = True
    app = globals().get('child')
    if app and app.poll() is None:
        app.terminate()
        try:
            app.wait(timeout=7)
        except subprocess.TimeoutExpired:
            app.kill()
            app.wait()
    if (root / 'home' / 'store.db').exists():
        result = subprocess.run(node + ['cleanup', str(root / 'home')] + (['5'] if passed else []), cwd=repo, text=True, capture_output=True)
        print('STORE', result.stdout, result.stderr, flush=True)
        if result.returncode:
            passed = False
            print('Cleanup failed', result.returncode, flush=True)
    for name in ['model_server', 'xvfb', 'log']:
        resource = globals().get(name)
        if resource:
            if name == 'model_server':
                resource.shutdown()
            elif name == 'log':
                resource.close()
            else:
                resource.terminate()
                resource.wait()
    print('ARTIFACTS', root, flush=True)
atexit.register(cleanup)

def free_port():
    with socket.socket() as server:
        server.bind(('127.0.0.1', 0))
        return server.getsockname()[1]
inspector_port = free_port()
xvfb = subprocess.Popen(['Xvfb', '-displayfd', '1', '-screen', '0', '1600x1000x24'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
display = xvfb.stdout.readline().strip()
os.environ.update(DISPLAY=':' + display, GDK_BACKEND='x11', WEBKIT_DISABLE_DMABUF_RENDERER='1')

class ModelHandler(http.server.BaseHTTPRequestHandler):

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        (root / 'model-request.json').write_text(json.dumps(body))
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        for delta, finish in [({'role': 'assistant', 'content': 'Seen images'}, None), ({}, 'stop')]:
            value = {'id': 'native-test', 'object': 'chat.completion.chunk', 'model': 'vision', 'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}
            self.wfile.write(('data: ' + json.dumps(value) + '\n\n').encode())
        self.wfile.write(b'data: [DONE]\n\n')

    def log_message(self, *args):
        pass
model_server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), ModelHandler)
threading.Thread(target=model_server.serve_forever, daemon=True).start()
home = root / 'home'
subprocess.check_output(node + ['seed', str(home), str(model_server.server_address[1])], cwd=repo, text=True)
os.chmod(home, 0o700)
log = open(root / 'native.log', 'w')
env = dict(os.environ, WEBKIT_INSPECTOR_HTTP_SERVER=f'127.0.0.1:{inspector_port}', HARNESS_HOME=str(home), OPENAI_API_KEY='', ANTHROPIC_API_KEY='', OPENCODE_API_KEY='')
child = subprocess.Popen([os.environ.get('HARNESS_NATIVE_EXECUTABLE', str(repo / 'packages/desktop/src-tauri/target/debug/harness-desktop'))], cwd=str(root), env=env, stdout=log, stderr=log)
import gi
gi.require_version('Gtk', '3.0')
gi.require_version('GdkX11', '3.0')
from gi.repository import Gtk, Gdk, GdkPixbuf, GLib, GdkX11
image = root / 'image.png'
pixbuf = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, True, 8, 16, 16)
pixbuf.fill(4282646783)
pixbuf.savev(str(image), 'png', [], [])
jpeg = root / 'image.jpg'
rgb = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, False, 8, 16, 16)
rgb.fill(4282646783)
rgb.savev(str(jpeg), 'jpeg', [], [])
ptr = ctypes.c_void_p
libx = ctypes.CDLL(ctypes.util.find_library('X11'))
xt = ctypes.CDLL(ctypes.util.find_library('Xtst'))
libgtk = ctypes.CDLL(ctypes.util.find_library('gtk-3'))
libgdk = ctypes.CDLL(ctypes.util.find_library('gdk-3'))
libx.XOpenDisplay.argtypes = [ctypes.c_char_p]
libx.XOpenDisplay.restype = ptr
xd = libx.XOpenDisplay(os.environ['DISPLAY'].encode())
libx.XFlush.argtypes = [ptr]
libx.XDefaultRootWindow.argtypes = [ptr]
libx.XDefaultRootWindow.restype = ctypes.c_ulong
rootx = libx.XDefaultRootWindow(xd)
libx.XQueryTree.argtypes = [ptr, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.POINTER(ctypes.c_ulong)), ctypes.POINTER(ctypes.c_uint)]
libx.XFetchName.argtypes = [ptr, ctypes.c_ulong, ctypes.POINTER(ctypes.c_char_p)]
libx.XMoveWindow.argtypes = [ptr, ctypes.c_ulong, ctypes.c_int, ctypes.c_int]
libx.XSetInputFocus.argtypes = [ptr, ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
libx.XStringToKeysym.argtypes = [ctypes.c_char_p]
libx.XStringToKeysym.restype = ctypes.c_ulong
libx.XKeysymToKeycode.argtypes = [ptr, ctypes.c_ulong]
libx.XKeysymToKeycode.restype = ctypes.c_uint
xt.XTestFakeKeyEvent.argtypes = [ptr, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
xt.XTestFakeMotionEvent.argtypes = [ptr, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
xt.XTestFakeButtonEvent.argtypes = [ptr, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
callbacks = []
libgdk.gdk_atom_intern_static_string.argtypes = [ctypes.c_char_p]
libgdk.gdk_atom_intern_static_string.restype = ptr
libgtk.gtk_clipboard_get.argtypes = [ptr]
libgtk.gtk_clipboard_get.restype = ptr
clip = libgtk.gtk_clipboard_get(libgdk.gdk_atom_intern_static_string(b'CLIPBOARD'))

class Target(ctypes.Structure):
    _fields_ = [('target', ctypes.c_char_p), ('flags', ctypes.c_uint), ('info', ctypes.c_uint)]
Getter = ctypes.CFUNCTYPE(None, ptr, ptr, ctypes.c_uint, ptr)
Clear = ctypes.CFUNCTYPE(None, ptr, ptr)
libgtk.gtk_clipboard_set_with_data.argtypes = [ptr, ctypes.POINTER(Target), ctypes.c_uint, Getter, Clear, ptr]
libgtk.gtk_selection_data_get_target.argtypes = [ptr]
libgtk.gtk_selection_data_get_target.restype = ptr
libgtk.gtk_selection_data_set.argtypes = [ptr, ptr, ctypes.c_int, ctypes.c_char_p, ctypes.c_int]

def clipboard(kind):
    c = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
    if kind == 'bitmap':
        c.set_image(pixbuf)
        return
    if kind == 'text':
        c.set_text('normal text stays text', -1)
        return
    if kind == 'path':
        c.set_text(str(image), -1)
        return
    payloads = [('image/jpeg', jpeg.read_bytes())] if kind == 'jpeg' else [('text/uri-list', 'https://example.com/image.png\r\n'), ('UTF8_STRING', 'https://example.com/image.png')] if kind == 'url' else [('text/uri-list', image.as_uri() + '\r\n'), ('x-special/gnome-copied-files', 'copy\n' + image.as_uri()), ('UTF8_STRING', str(image))]
    targets = (Target * len(payloads))(*[Target(name.encode(), 0, i) for i, (name, data) in enumerate(payloads)])

    @Getter
    def get(c, s, info, data):
        value = payloads[info][1]
        value = value.encode() if isinstance(value, str) else value
        libgtk.gtk_selection_data_set(s, libgtk.gtk_selection_data_get_target(s), 8, value, len(value))

    @Clear
    def clear(c, data):
        pass
    callbacks.extend([targets, get, clear])
    libgtk.gtk_clipboard_set_with_data(clip, targets, len(payloads), get, clear, None)
in_eval = False

def evaljs(expression):
    global in_eval
    in_eval = True
    process = subprocess.Popen(node + ['evaluate', ws, expression], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=repo)
    try:
        while process.poll() is None:
            while Gtk.events_pending():
                Gtk.main_iteration_do(False)
            time.sleep(0.005)
        out, err = process.communicate()
        if process.returncode:
            raise Exception('Inspector helper: ' + str(process.returncode) + ' ' + err)
        result = json.loads(out)
    finally:
        in_eval = False
    if result.get('error') or result.get('result', {}).get('wasThrown'):
        raise Exception(str(result))
    return result['result']['result'].get('value')

def windows():
    a = ctypes.c_ulong()
    b = ctypes.c_ulong()
    items = ctypes.POINTER(ctypes.c_ulong)()
    n = ctypes.c_uint()
    libx.XQueryTree(xd, rootx, ctypes.byref(a), ctypes.byref(b), ctypes.byref(items), ctypes.byref(n))
    result = []
    for i in range(n.value):
        name = ctypes.c_char_p()
        libx.XFetchName(xd, items[i], ctypes.byref(name))
        result.append((items[i], (name.value or b'').decode(errors='replace')))
    return result

def key(name, down):
    xt.XTestFakeKeyEvent(xd, libx.XKeysymToKeycode(xd, libx.XStringToKeysym(name.encode())), down, 0)
    libx.XFlush(xd)

def chord(name):
    key('Control_L', 1)
    key(name, 1)
    key(name, 0)
    key('Control_L', 0)

def motion(x, y):
    xt.XTestFakeMotionEvent(xd, 0, int(x), int(y), 0)
    libx.XFlush(xd)

def button(down):
    xt.XTestFakeButtonEvent(xd, 1, down, 0)
    libx.XFlush(xd)

def focus():
    libx.XSetInputFocus(xd, appwin, 1, 0)
    libx.XFlush(xd)
    evaljs("document.querySelector('textarea[aria-label=Message]').focus();true")

def count():
    return evaljs("document.querySelectorAll('.composer .image-preview').length")

def report(name, value):
    print(json.dumps({'check': name, 'result': value}), flush=True)
source = Gtk.Window(title='Native DND Source')
source.set_default_size(180, 200)
source.move(0, 0)
box = Gtk.EventBox()
box.add(Gtk.Label(label='DRAG IMAGE'))
source.add(box)
box.drag_source_set(Gdk.ModifierType.BUTTON1_MASK, [Gtk.TargetEntry.new('text/uri-list', 0, 2)], Gdk.DragAction.COPY)
box.connect('drag-data-get', lambda w, c, d, i, t: d.set_uris([image.as_uri()]))
source.show_all()
phase = 'ready'
deadline = time.monotonic() + 35
ws = None
appwin = None

def dragstep(step, target):
    if step == 0:
        motion(90, 90)
    elif step == 1:
        button(1)
    elif step < 15:
        t = (step - 1) / 13
        motion(90 + (target[0] - 90) * t, 90 + (target[1] - 90) * t)
    else:
        button(0)
        return False
    GLib.timeout_add(65, dragstep, step + 1, target)
    return False

def tick():
    global phase, ws, appwin, deadline, passed
    if in_eval:
        return True
    try:
        if time.monotonic() > deadline:
            raise Exception('timeout ' + phase)
        if phase == 'ready':
            try:
                html = urllib.request.urlopen(f'http://127.0.0.1:{inspector_port}/', timeout=0.3).read().decode()
                match = re.search('(/socket/\\d+/\\d+/WebPage)', html)
                if not match:
                    return True
                ws = f'ws://127.0.0.1:{inspector_port}' + match.group(1)
                names = windows()
                appwin = next((w for w, n in names if 'Harness' in n), None)
                if not appwin:
                    return True
                libx.XMoveWindow(xd, appwin, 230, 0)
                libx.XFlush(xd)
                found = evaljs("(()=>{const a=[...document.querySelectorAll('a')].find(a=>a.textContent.includes('Native image probe'));if(a)a.click();return !!document.querySelector('textarea[aria-label=Message]')})()")
                if not found:
                    return True
                report('app-ready', True)
                clipboard('uri')
                focus()
                chord('v')
                phase = 'uri'
                deadline = time.monotonic() + 15
            except Exception as e:
                report('waiting', str(e)[:120])
                return True
        elif phase == 'uri':
            if count() != 1:
                return True
            report('copied-file-native-paste', 1)
            clipboard('bitmap')
            focus()
            chord('v')
            phase = 'bitmap'
        elif phase == 'bitmap':
            if count() != 2:
                return True
            report('bitmap-native-paste', 2)
            clipboard('jpeg')
            focus()
            chord('v')
            phase = 'jpeg'
        elif phase == 'jpeg':
            if count() != 3:
                return True
            report('JPEG-only-native-paste', 3)
            clipboard('text')
            focus()
            chord('v')
            phase = 'text'
        elif phase == 'text':
            text = evaljs("document.querySelector('textarea[aria-label=Message]').value")
            if text != 'normal text stays text':
                return True
            report('plain-text-preserved', {'text': text, 'images': count()})
            clipboard('url')
            focus()
            chord('a')
            chord('v')
            phase = 'url'
            return True
        elif phase == 'url':
            text = evaljs("document.querySelector('textarea[aria-label=Message]').value")
            if text != 'https://example.com/image.png':
                return True
            report('URL-text-preserved', {'text': text, 'images': count()})
            target = evaljs("(()=>{const r=document.querySelector('.conversation-scroll').getBoundingClientRect();return [r.left+r.width/2,r.top+100]})()")
            dragstep(0, [target[0] + 230, target[1]])
            phase = 'drop'
            deadline = time.monotonic() + 15
        elif phase == 'drop':
            if count() != 4:
                return True
            report('native-os-file-drop-over-transcript', 4)
            target = evaljs('(()=>{const r=document.querySelector(\'button[aria-label="Attach images"]\').getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()')
            motion(target[0] + 230, target[1])
            button(1)
            button(0)
            phase = 'picker'
            deadline = time.monotonic() + 15
        elif phase == 'picker':
            names = windows()
            choices = [(w, n) for w, n in names if 'Open' in n or 'File' in n]
            if not choices:
                return True
            report('native-file-picker-visible', choices)
            clipboard('path')
            key('Control_L', 1)
            key('l', 1)
            key('l', 0)
            key('Control_L', 0)
            GLib.timeout_add(200, lambda: (chord('v'), key('Return', 1), key('Return', 0), False)[-1])
            phase = 'picker-result'
        elif phase == 'picker-result':
            if count() != 5:
                return True
            report('native-file-picker-attachment', 5)
            report('final-dom', evaljs("JSON.stringify({images:document.querySelectorAll('.composer .image-preview').length,text:document.querySelector('textarea[aria-label=Message]').value,alerts:[...document.querySelectorAll('[role=alert]')].map(x=>x.textContent)})"))
            target = evaljs("(()=>{const r=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Send').getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()")
            motion(target[0] + 230, target[1])
            button(1)
            button(0)
            phase = 'sent'
            deadline = time.monotonic() + 15
        elif phase == 'sent':
            if not (root / 'model-request.json').exists():
                return True
            previews = evaljs("document.querySelectorAll('.cell.user .image-preview').length")
            if previews != 5:
                return True
            request = json.loads((root / 'model-request.json').read_text())
            images = [b for m in request['messages'] for b in m.get('content', []) if isinstance(b, dict) and b.get('type') == 'image_url']
            assert len(images) == 5 and str(image) not in json.dumps(request)
            report('native-send-log-and-model', {'userPreviews': previews, 'modelImages': len(images), 'clientPathInPayload': False})
            passed = True
            Gtk.main_quit()
            return False
    except Exception as e:
        report('FAIL', str(e))
        report('windows', windows())
        try:
            report('body', evaljs('document.body.innerText.slice(-2500)'))
        except Exception:
            pass
        Gtk.main_quit()
        return False
    return True
GLib.timeout_add(150, tick)
Gtk.main()
cleanup()
sys.exit(0 if passed else 1)
