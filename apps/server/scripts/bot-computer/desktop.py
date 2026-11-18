#!/usr/bin/python3
"""Loopback desktop bridge. Run as the unprivileged bot account behind SSH."""
import base64
import http.server
import io
import json
import os
from pathlib import Path
import re
import socket
import socketserver
import subprocess
import sys
import threading
import traceback
import urllib.request

WIDTH, HEIGHT, BAR = 1280, 800, 40
STATE = Path.home() / '.cache/rejects-desktops'
CDP = os.environ.get('REJECTS_CDP_URL', 'http://127.0.0.1:9223')
PORT = 9333

def request(url, data=None):
    with urllib.request.urlopen(urllib.request.Request(url, data=json.dumps(data).encode() if data is not None else None, headers={'Content-Type': 'application/json'}), timeout=20) as response:
        return json.load(response)

def local_call(path, payload):
    with socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(20)
        connection.connect(str(path))
        connection.sendall(json.dumps(payload).encode() + b'\n')
        result = b''
        while not result.endswith(b'\n'):
            chunk = connection.recv(65536)
            if not chunk:
                raise RuntimeError('Desktop viewer disconnected')
            result += chunk
        decoded = json.loads(result)
        if 'error' in decoded:
            raise RuntimeError(decoded['error'])
        return decoded

class Desktop:
    def __init__(self, bot, target):
        self.lock = threading.Lock()
        self.cancel = threading.Event()
        self.target = target
        self.path = STATE / (bot + '.sock')
        self.path.unlink(missing_ok=True)
        self.x = subprocess.Popen(['Xvfb', '-displayfd', '1', '-screen', '0', f'{WIDTH}x{HEIGHT}x24', '-nolisten', 'tcp', '-nolisten', 'local', '-ac', '-noreset'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        number = self.x.stdout.readline().decode().strip()
        if not number.isdigit():
            self.x.terminate()
            raise RuntimeError('Could not start the virtual display')
        self.display = ':' + number
        self.env = dict(os.environ, DISPLAY=self.display)
        self.wm = subprocess.Popen(['openbox'], env=self.env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.view = subprocess.Popen([sys.executable, __file__, 'view', str(self.path), target], env=self.env, stdout=subprocess.PIPE, stderr=sys.stderr)
        if self.view.stdout.readline() != b'ready\n':
            self.close()
            raise RuntimeError('Could not start the browser viewer')

    def close(self):
        for process in [getattr(self, name, None) for name in ['view', 'wm', 'x']]:
            if process and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
        self.path.unlink(missing_ok=True)

    def xdo(self, *args, text=None):
        subprocess.run(['xdotool', *args], input=text, text=True, env=self.env, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)

    def act(self, payload):
        action = payload['action']
        if action == 'ensure':
            return {'display': self.display}
        if action == 'release':
            self.xdo('mouseup', '1', 'mouseup', '2', 'mouseup', '3', 'keyup', 'Control_L', 'Alt_L', 'Shift_L', 'Super_L')
            return {}
        if action == 'screenshot':
            local_call(self.path, {'action': 'refresh'})
            from PIL import ImageGrab
            image = ImageGrab.grab(xdisplay=self.display)
            output = io.BytesIO()
            image.save(output, format='PNG')
            return {'screenshot': {'mimeType': 'image/png', 'data': base64.b64encode(output.getvalue()).decode(), 'width': WIDTH, 'height': HEIGHT}}
        if action in ['click', 'double-click', 'drag', 'scroll']:
            x, y = payload.get('x', WIDTH // 2), payload.get('y', HEIGHT // 2)
            if not (isinstance(x, int) and isinstance(y, int) and 0 <= x < WIDTH and 0 <= y < HEIGHT):
                raise ValueError('Coordinates must be inside the 1280x800 screen')
            self.xdo('mousemove', str(x), str(y))
            if action in ['click', 'double-click']:
                button = {'left': '1', 'middle': '2', 'right': '3'}[payload.get('button', 'left')]
                self.xdo('click', '--repeat', '2' if action == 'double-click' else '1', '--delay', '100', button)
            elif action == 'drag':
                end_x, end_y = payload['toX'], payload['toY']
                if not (isinstance(end_x, int) and isinstance(end_y, int) and 0 <= end_x < WIDTH and 0 <= end_y < HEIGHT):
                    raise ValueError('Drag destination is outside the screen')
                try:
                    self.xdo('mousedown', '1', 'mousemove', str(end_x), str(end_y))
                finally:
                    self.xdo('mouseup', '1')
            else:
                count = payload.get('amount', 3)
                if not isinstance(count, int) or not 1 <= count <= 20:
                    raise ValueError('Scroll amount must be 1..20')
                direction = payload.get('direction', 'down')
                self.xdo(*(['keydown', 'shift'] if direction in ['left', 'right'] else []), 'click', '--repeat', str(count), '--delay', '40', '4' if direction in ['up', 'left'] else '5', *(['keyup', 'shift'] if direction in ['left', 'right'] else []))
        elif action == 'type':
            text = payload['text']
            if not isinstance(text, str) or len(text) > 20000:
                raise ValueError('Text is too long')
            self.xdo('type', '--clearmodifiers', '--delay', '0', '--file', '-', text=text)
        elif action == 'key':
            key = payload['text']
            if not isinstance(key, str) or not re.fullmatch(r'[A-Za-z0-9_+]+', key) or len(key) > 100:
                raise ValueError('Invalid key chord')
            self.xdo('key', '--clearmodifiers', key)
        elif action == 'wait':
            # A timer wait leaves this display's queue occupied, without blocking other bots.
            seconds = payload.get('seconds', 1)
            if not isinstance(seconds, (int, float)) or not 0 <= seconds <= 10:
                raise ValueError('Wait must be 0..10 seconds')
            self.cancel.clear()
            if self.cancel.wait(seconds):
                raise RuntimeError('Computer action stopped')
        else:
            raise ValueError('Unknown desktop action')
        local_call(self.path, {'action': 'sync'})
        return {}

# Tk renders only on explicit refresh or input. It has no screenshot timer.
def view(path, target):
    import tkinter as tk
    import websocket
    import queue
    page = request(CDP + '/json/list')
    info = next(entry for entry in page if entry['id'] == target)
    ws = websocket.create_connection(info['webSocketDebuggerUrl'], timeout=15, suppress_origin=True)
    sequence = 0
    def cdp(method, params=None):
        nonlocal sequence
        sequence += 1
        ws.send(json.dumps({'id': sequence, 'method': method, 'params': params or {}}))
        while True:
            reply = json.loads(ws.recv())
            if reply.get('id') == sequence:
                if 'error' in reply:
                    raise RuntimeError('Browser action failed')
                return reply.get('result', {})
    cdp('Emulation.setDeviceMetricsOverride', {'width': WIDTH, 'height': HEIGHT - BAR, 'deviceScaleFactor': 1, 'mobile': False})
    root = tk.Tk()
    root.title('Browser')
    root.configure(bg='black')
    root.geometry(f'{WIDTH}x{HEIGHT}+0+0')
    root.attributes('-fullscreen', True)
    toolbar = tk.Frame(root, height=BAR, bg='black')
    toolbar.pack(fill='x'); toolbar.pack_propagate(False)
    address = tk.Entry(toolbar, bg='black', fg='white', insertbackground='white', relief='flat', font=('sans', 12))
    address.pack(fill='both', expand=True, padx=12, pady=6)
    canvas = tk.Canvas(root, width=WIDTH, height=HEIGHT - BAR, highlightthickness=0, bg='black')
    canvas.pack(fill='both', expand=True)
    picture = None
    item = canvas.create_image(0, 0, anchor='nw')
    def refresh():
        nonlocal picture
        shot = cdp('Page.captureScreenshot', {'format': 'png', 'captureBeyondViewport': False})
        picture = tk.PhotoImage(data=shot['data'])
        canvas.itemconfigure(item, image=picture)
        if root.focus_get() != address:
            url = cdp('Runtime.evaluate', {'expression': 'location.href', 'returnByValue': True})['result'].get('value', '')
            address.delete(0, 'end'); address.insert(0, url)
        root.update_idletasks()
    def navigate(_event):
        url = address.get()
        if not url.startswith(('https://', 'http://')):
            url = 'https://' + url
        cdp('Page.navigate', {'url': url}); canvas.focus_force()
    address.bind('<Return>', navigate)
    def focus_address(_event):
        address.focus_force(); address.selection_range(0, 'end')
        return 'break'
    root.bind('<Control-l>', focus_address)
    click_count = 1
    def mouse(event, kind, count=None):
        nonlocal click_count
        if kind == 'mousePressed':
            click_count = count or 1
        canvas.focus_force()
        button = {1: 'left', 2: 'middle', 3: 'right'}.get(event.num, 'none')
        cdp('Input.dispatchMouseEvent', {'type': kind, 'x': event.x, 'y': event.y, 'button': button, 'clickCount': click_count})
    canvas.bind('<ButtonPress-1>', lambda e: mouse(e, 'mousePressed'))
    canvas.bind('<Double-ButtonPress-1>', lambda e: mouse(e, 'mousePressed', 2))
    canvas.bind('<ButtonPress-2>', lambda e: mouse(e, 'mousePressed'))
    canvas.bind('<ButtonRelease-2>', lambda e: mouse(e, 'mouseReleased'))
    canvas.bind('<ButtonRelease-1>', lambda e: mouse(e, 'mouseReleased'))
    canvas.bind('<ButtonPress-3>', lambda e: mouse(e, 'mousePressed'))
    canvas.bind('<ButtonRelease-3>', lambda e: mouse(e, 'mouseReleased'))
    canvas.bind('<B1-Motion>', lambda e: cdp('Input.dispatchMouseEvent', {'type': 'mouseMoved', 'x': e.x, 'y': e.y, 'button': 'left', 'buttons': 1}))
    for button, delta in [(4, -200), (5, 200)]:
        canvas.bind(f'<Button-{button}>', lambda e, delta=delta: cdp('Input.dispatchMouseEvent', {'type': 'mouseWheel', 'x': e.x, 'y': e.y, 'deltaX': delta if e.state & 1 else 0, 'deltaY': 0 if e.state & 1 else delta}))
    keys = {'Return': 'Enter', 'BackSpace': 'Backspace', 'Tab': 'Tab', 'Escape': 'Escape', 'Left': 'ArrowLeft', 'Right': 'ArrowRight', 'Up': 'ArrowUp', 'Down': 'ArrowDown', 'Delete': 'Delete', 'Home': 'Home', 'End': 'End', 'Prior': 'PageUp', 'Next': 'PageDown'}
    def key(event, pressed):
        modifier = (2 if event.state & 4 else 0) | (1 if event.state & 8 else 0) | (8 if event.state & 1 else 0)
        if pressed and event.char and event.char.isprintable() and not modifier & 3:
            cdp('Input.insertText', {'text': event.char}); return
        virtual = {'Return': 13, 'BackSpace': 8, 'Tab': 9, 'Escape': 27, 'Left': 37, 'Up': 38, 'Right': 39, 'Down': 40, 'Delete': 46, 'Home': 36, 'End': 35}.get(event.keysym, ord(event.keysym.upper()) if len(event.keysym) == 1 else 0)
        cdp('Input.dispatchKeyEvent', {'type': 'keyDown' if pressed else 'keyUp', 'key': keys.get(event.keysym, event.keysym), 'modifiers': modifier, 'windowsVirtualKeyCode': virtual})
    canvas.bind('<KeyPress>', lambda e: key(e, True))
    canvas.bind('<KeyRelease>', lambda e: key(e, False))
    work = queue.Queue()
    class Commands(socketserver.StreamRequestHandler):
        def handle(self):
            task = json.loads(self.rfile.readline(1024))
            done = threading.Event(); response = {}
            work.put((task, done, response))
            if not done.wait(20):
                response['error'] = 'Desktop render timed out'
            self.wfile.write(json.dumps(response).encode() + b'\n')
    server = socketserver.ThreadingUnixStreamServer(path, Commands)
    os.chmod(path, 0o600)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    def drain():
        try:
            while True:
                task, done, response = work.get_nowait()
                try:
                    root.update()
                    if task['action'] == 'refresh':
                        refresh()
                    else:
                        cdp('Runtime.evaluate', {'expression': '0'})
                except Exception:
                    response['error'] = 'Could not refresh browser viewer'
                finally:
                    done.set()
        except queue.Empty:
            pass
        root.after(20, drain)
    refresh(); canvas.focus_force(); drain()
    print('ready', flush=True)
    root.mainloop()

class Handler(http.server.BaseHTTPRequestHandler):
    desktops = {}
    lock = threading.Lock()
    def log_message(self, *_args):
        pass
    def do_POST(self):
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 100000:
                raise ValueError('Invalid request size')
            data = json.loads(self.rfile.read(length))
            bot = data['id']
            if not isinstance(bot, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', bot):
                raise ValueError('Invalid bot id')
            action = data['action']
            with self.lock:
                desktop = self.desktops.get(bot)
                if action == 'close':
                    if desktop:
                        desktop.close(); del self.desktops[bot]
                    result = {}
                elif desktop is None and action == 'release':
                    result = {}
                elif desktop is not None and data.get('targetId') not in [None, desktop.target]:
                    desktop.close()
                    desktop = Desktop(bot, data['targetId'])
                    self.desktops[bot] = desktop
                elif desktop is None:
                    target = data['targetId']
                    if not re.fullmatch(r'[A-Fa-f0-9]{32}', target):
                        raise ValueError('Invalid browser target')
                    desktop = Desktop(bot, target)
                    self.desktops[bot] = desktop
            if action != 'close' and desktop:
                if action == 'release':
                    desktop.cancel.set()
                if action == 'screenshot':
                    result = desktop.act(data)
                else:
                    with desktop.lock:
                        result = desktop.act(data)
            body = json.dumps(result).encode()
            self.send_response(200)
        except Exception:
            traceback.print_exc()
            body = b'{"error":"Desktop action failed"}'
            self.send_response(500)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers(); self.wfile.write(body)

if __name__ == '__main__':
    if sys.argv[1:2] == ['view']:
        view(sys.argv[2], sys.argv[3])
    elif sys.argv[1:2] == ['call']:
        result = request(f'http://127.0.0.1:{PORT}/', json.load(sys.stdin))
        print(json.dumps(result))
    else:
        STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
        http.server.ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
