import Connection from "./connection";
import _sodium from "libsodium-wrappers";
import { CursorData } from "./message";
import { loadVp9 } from "./codec";
import { checkIfRetry, version } from "./gen_js_from_hbb";
import { initZstd, translate } from "./common";
import PCMPlayer from "pcm-player";

window.curConn = undefined;
window.isMobile = () => {
  return /(android|bb\d+|meego).+mobile|avantgo|bada\/|blackberry|blazer|compal|elaine|fennec|hiptop|iemobile|ip(hone|od)|ipad|iris|kindle|Android|Silk|lge |maemo|midp|mmp|netfront|opera m(ob|in)i|palm( os)?|phone|p(ixi|re)\/|plucker|pocket|psp|series(4|6)0|symbian|treo|up\.(browser|link)|vodafone|wap|windows (ce|phone)|xda|xiino/i.test(navigator.userAgent)
    || /1207|6310|6590|3gso|4thp|50[1-6]i|770s|802s|a wa|abac|ac(er|oo|s\-)|ai(ko|rn)|al(av|ca|co)|amoi|an(ex|ny|yw)|aptu|ar(ch|go)|as(te|us)|attw|au(di|\-m|r |s )|avan|be(ck|ll|nq)|bi(lb|rd)|bl(ac|az)|br(e|v)w|bumb|bw\-(n|u)|c55\/|capi|ccwa|cdm\-|cell|chtm|cldc|cmd\-|co(mp|nd)|craw|da(it|ll|ng)|dbte|dc\-s|devi|dica|dmob|do(c|p)o|ds(12|\-d)|el(49|ai)|em(l2|ul)|er(ic|k0)|esl8|ez([4-7]0|os|wa|ze)|fetc|fly(\-|_)|g1 u|g560|gene|gf\-5|g\-mo|go(\.w|od)|gr(ad|un)|haie|hcit|hd\-(m|p|t)|hei\-|hi(pt|ta)|hp( i|ip)|hs\-c|ht(c(\-| |_|a|g|p|s|t)|tp)|hu(aw|tc)|i\-(20|go|ma)|i230|iac( |\-|\/)|ibro|idea|ig01|ikom|im1k|inno|ipaq|iris|ja(t|v)a|jbro|jemu|jigs|kddi|keji|kgt( |\/)|klon|kpt |kwc\-|kyo(c|k)|le(no|xi)|lg( g|\/(k|l|u)|50|54|\-[a-w])|libw|lynx|m1\-w|m3ga|m50\/|ma(te|ui|xo)|mc(01|21|ca)|m\-cr|me(rc|ri)|mi(o8|oa|ts)|mmef|mo(01|02|bi|de|do|t(\-| |o|v)|zz)|mt(50|p1|v )|mwbp|mywa|n10[0-2]|n20[2-3]|n30(0|2)|n50(0|2|5)|n7(0(0|1)|10)|ne((c|m)\-|on|tf|wf|wg|wt)|nok(6|i)|nzph|o2im|op(ti|wv)|oran|owg1|p800|pan(a|d|t)|pdxg|pg(13|\-([1-8]|c))|phil|pire|pl(ay|uc)|pn\-2|po(ck|rt|se)|prox|psio|pt\-g|qa\-a|qc(07|12|21|32|60|\-[2-7]|i\-)|qtek|r380|r600|raks|rim9|ro(ve|zo)|s55\/|sa(ge|ma|mm|ms|ny|va)|sc(01|h\-|oo|p\-)|sdk\/|se(c(\-|0|1)|47|mc|nd|ri)|sgh\-|shar|sie(\-|m)|sk\-0|sl(45|id)|sm(al|ar|b3|it|t5)|so(ft|ny)|sp(01|h\-|v\-|v )|sy(01|mb)|t2(18|50)|t6(00|10|18)|ta(gt|lk)|tcl\-|tdg\-|tel(i|m)|tim\-|t\-mo|to(pl|sh)|ts(70|m\-|m3|m5)|tx\-9|up(\.b|g1|si)|utst|v400|v750|veri|vi(rg|te)|vk(40|5[0-3]|\-v)|vm40|voda|vulc|vx(52|53|60|61|70|80|81|83|85|98)|w3c(\-| )|webc|whit|wi(g |nc|nw)|wmlb|wonu|x700|yas\-|your|zeto|zte\-/i.test(navigator.userAgent.substr(0, 4));
}

export function isDesktop() {
  return !isMobile();
}

const userDefaults = {
  'view_style': 'original',
  'image_quality': 'balanced',
  'codec-preference': 'auto',
  'scroll_style': 'scrollauto',
  'custom-image-quality': '50',
};

function getDefaultOption(arg) {
  const val = localStorage.getItem('option:user:default:' + arg);
  if (val !== null) return val;
  return userDefaults[arg] || '';
}

function getRecentPeersList() {
  const list = [];
  const peers = getPeers();
  const sortedIds = Object.keys(peers).sort((a, b) => {
    return ((peers[b] || {}).tm || 0) - ((peers[a] || {}).tm || 0);
  });
  for (const id of sortedIds) {
    if (!id) continue;
    const option = peers[id];
    if (!option) continue;
    const info = option.info || {};
    list.push({
      id: id,
      username: info.username || '',
      hostname: info.hostname || '',
      platform: info.platform || '',
      alias: option.alias || '',
      tags: option.tags || [],
      forceAlwaysRelay: option.forceAlwaysRelay || 'false',
      rdpPort: option.rdpPort || '',
      rdpUsername: option.rdpUsername || '',
      loginName: option.loginName || '',
      device_group_name: option.device_group_name || '',
    });
  }
  return list;
}

export function msgbox(type, title, text) {
  if (!type || (type == 'error' && !text)) return;
  const text2 = text.toLowerCase();
  var hasRetry = checkIfRetry(type, title, text) ? 'true' : '';
  if (typeof onGlobalEvent === 'function') {
    onGlobalEvent(JSON.stringify({ name: 'msgbox', type, title, text, hasRetry, link: '' }));
  } else if (typeof onRegisteredEvent === 'function') {
    onRegisteredEvent(JSON.stringify({ name: 'msgbox', type, title, text, hasRetry, link: '' }));
  } else {
    console.warn("onGlobalEvent and onRegisteredEvent are not defined yet, skipped msgbox: " + type);
  }
}

function jsonfyForDart(payload) {
  var tmp = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!key) continue;
    if (key === 'platform_additions') {
      tmp[key] = value;
    } else {
      tmp[key] = value instanceof Uint8Array ? '[' + value.toString() + ']' : JSON.stringify(value);
    }
  }
  return tmp;
}

export function pushEvent(name, payload) {
  payload = jsonfyForDart(payload);
  payload.name = name;
  if (typeof onGlobalEvent === 'function') {
    onGlobalEvent(JSON.stringify(payload));
  } else if (typeof onRegisteredEvent === 'function') {
    onRegisteredEvent(JSON.stringify(payload));
  } else {
    console.warn("onGlobalEvent and onRegisteredEvent are not defined yet, skipped pushEvent: " + name);
  }
}

let yuvWorker;
let yuvCanvas;
let gl;
let pixels;
let flipPixels;
let oldSize;
if (YUVCanvas.WebGLFrameSink.isAvailable()) {
  var canvas = document.createElement('canvas');
  yuvCanvas = YUVCanvas.attach(canvas, { webGL: true });
  gl = canvas.getContext("webgl");
} else {
  yuvWorker = new Worker("./yuv.js");
}
let testSpeed = [0, 0];

export function draw(frame, id) {
  if (yuvWorker) {
    // frame's (y/u/v).bytes already detached, can not transferrable any more.
    yuvWorker.postMessage({ frame, id });
  } else {
    var tm0 = new Date().getTime();
    yuvCanvas.drawFrame(frame);
    var width = canvas.width;
    var height = canvas.height;
    var size = width * height * 4;
    if (size != oldSize) {
      pixels = new Uint8Array(size);
      flipPixels = new Uint8Array(size);
      oldSize = size;
    }
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const row = width * 4;
    const end = (height - 1) * row;
    for (let i = 0; i < size; i += row) {
      flipPixels.set(pixels.subarray(i, i + row), end - i);
    }
    window.onRgba?.(id, 0, flipPixels);
    testSpeed[1] += new Date().getTime() - tm0;
    testSpeed[0] += 1;
    if (testSpeed[0] > 30) {
      // console.log('gl: ' + parseInt('' + testSpeed[1] / testSpeed[0]));
      testSpeed = [0, 0];
    }
  }
  /*
  var testCanvas = document.getElementById("test-yuv-decoder-canvas");
  if (testCanvas && currentFrame) {
    var ctx = testCanvas.getContext("2d");
    testCanvas.width = frame.format.displayWidth;
    testCanvas.height = frame.format.displayHeight;
    var img = ctx.createImageData(testCanvas.width, testCanvas.height);
    img.data.set(currentFrame);
    ctx.putImageData(img, 0, 0);
  }
  */
}

export function sendOffCanvas(c) {
  let canvas = c.transferControlToOffscreen();
  yuvWorker.postMessage({ canvas }, [canvas]);
}

export function setConn(conn) {
  window.curConn = conn;
}

export function getConn() {
  return window.curConn;
}

export async function startConn(id) {
  setByName('remote_id', id);
  await curConn.start(id);
}

export function close() {
  getConn()?.close();
  setConn(undefined);
}

export function newConn() {
  window.curConn?.close();
  const conn = new Connection();
  setConn(conn);
  return conn;
}

let sodium;
export async function verify(signed, pk) {
  if (!sodium) {
    await _sodium.ready;
    sodium = _sodium;
  }
  if (typeof pk == 'string') {
    pk = decodeBase64(pk);
  }
  return sodium.crypto_sign_open(signed, pk);
}

export function decodeBase64(pk) {
  return sodium.from_base64(pk, sodium.base64_variants.ORIGINAL);
}

export function genBoxKeyPair() {
  const pair = sodium.crypto_box_keypair();
  const sk = pair.privateKey;
  const pk = pair.publicKey;
  return [sk, pk];
}

export function genSecretKey() {
  return sodium.crypto_secretbox_keygen();
}

export function seal(unsigned, theirPk, ourSk) {
  const nonce = Uint8Array.from(Array(24).fill(0));
  return sodium.crypto_box_easy(unsigned, nonce, theirPk, ourSk);
}

function makeOnce(value) {
  var byteArray = Array(24).fill(0);

  for (var index = 0; index < byteArray.length && value > 0; index++) {
    var byte = value & 0xff;
    byteArray[index] = byte;
    value = (value - byte) / 256;
  }

  return Uint8Array.from(byteArray);
};

export function encrypt(unsigned, nonce, key) {
  return sodium.crypto_secretbox_easy(unsigned, makeOnce(nonce), key);
}

export function decrypt(signed, nonce, key) {
  return sodium.crypto_secretbox_open_easy(signed, makeOnce(nonce), key);
}

window.setByName = (name, value) => {
  switch (name) {
    case 'session_add_sync':
      // console.log('setByName session_add_sync received:', value);
      value = JSON.parse(value);
      const conn = newConn();
      if (value.password) {
        conn._plainPassword = value.password;
      }
      conn._isFileTransfer = value.isFileTransfer === true || value.isFileTransfer == 'true';
      conn._isViewCamera = value.isViewCamera === true || value.isViewCamera == 'true';
      conn._isTerminal = value.isTerminal === true || value.isTerminal == 'true';
      // console.log('Created connection with _isFileTransfer:', conn._isFileTransfer, '_isViewCamera:', conn._isViewCamera, '_isTerminal:', conn._isTerminal);
      return true;
    case 'session_start':
      value = JSON.parse(value);
      startConn(value.id);
      break;
    case 'remote_id':
      localStorage.setItem('remote-id', value);
      break;
    case 'connect':
      newConn();
      startConn(value);
      break;
    case 'login':
      value = JSON.parse(value);
      curConn.setRemember(value.remember === true || value.remember == 'true');
      curConn.login(value.password);
      break;
    case 'close':
      close();
      break;
    case 'open_terminal':
      if (window.curConn) {
        const val = JSON.parse(value);
        window.curConn.sendTerminalAction({
          open: {
            terminalId: val.terminal_id,
            rows: val.rows,
            cols: val.cols,
          }
        });
      }
      break;
    case 'send_terminal_input':
      if (window.curConn) {
        const val = JSON.parse(value);
        window.curConn.sendTerminalAction({
          data: {
            terminalId: val.terminal_id,
            data: new TextEncoder().encode(val.data),
            compressed: false,
          }
        });
      }
      break;
    case 'resize_terminal':
      if (window.curConn) {
        const val = JSON.parse(value);
        window.curConn.sendTerminalAction({
          resize: {
            terminalId: val.terminal_id,
            rows: val.rows,
            cols: val.cols,
          }
        });
      }
      break;
    case 'close_terminal':
      if (window.curConn) {
        const val = JSON.parse(value);
        window.curConn.sendTerminalAction({
          close: {
            terminalId: val.terminal_id,
          }
        });
      }
      break;
    case 'refresh':
      curConn.refresh();
      break;
    case 'reconnect':
      curConn.reconnect();
      break;
    case 'toggle_option':
    case 'option:toggle':
      // console.log('setByName option:toggle received:', value);
      if (curConn) {
        // console.log('curConn is active, calling toggleOption with:', value);
        curConn.toggleOption(value);
      } else {
        console.warn('curConn is not active, skipped toggleOption!');
      }
      break;
    case 'image_quality':
      curConn.setImageQuality(value);
      break;
    case 'lock_screen':
      curConn.lockScreen();
      break;
    case 'ctrl_alt_del':
      curConn.ctrlAltDel();
      break;
    case 'switch_display':
      curConn.switchDisplay(value);
      break;
    case 'change_resolution':
      // console.log('setByName change_resolution received:', value);
      if (curConn) {
        value = JSON.parse(value);
        curConn.changeResolution(value.display, value.width, value.height);
      }
      break;
    case 'read_remote_dir':
      // console.log('setByName read_remote_dir received:', value);
      if (curConn) {
        value = JSON.parse(value);
        curConn.readDir(value.path, value.include_hidden === true || value.include_hidden == 'true');
      }
      break;
    case 'send_files':
      // console.log('setByName send_files received:', value);
      if (curConn) {
        value = JSON.parse(value);
        curConn.sendFiles(
          value.id,
          value.path,
          value.to,
          value.file_num,
          value.include_hidden === true || value.include_hidden == 'true',
          value.is_remote === true || value.is_remote == 'true',
          value.is_dir === true || value.is_dir == 'true'
        );
      }
      break;
    case 'remove_file':
      // console.log('setByName remove_file received:', value);
      if (curConn) {
        value = JSON.parse(value);
        curConn.removeFile(
          value.id,
          value.path,
          value.file_num,
          value.is_remote === true || value.is_remote == 'true'
        );
      }
      break;
    case 'read_dir_to_remove_recursive':
      // console.log('setByName read_dir_to_remove_recursive received:', value);
      if (curConn) {
        value = JSON.parse(value);
        curConn.readDirToRemoveRecursive(
          value.id,
          value.path,
          value.is_remote === true || value.is_remote == 'true',
          value.show_hidden === true || value.show_hidden == 'true'
        );
      }
      break;
    case 'remove_all_empty_dirs':
      // console.log('setByName remove_all_empty_dirs received:', value);
      if (curConn) {
        value = JSON.parse(value);
        curConn.removeAllEmptyDirs(
          value.id,
          value.path,
          value.is_remote === true || value.is_remote == 'true'
        );
      }
      break;
    case 'cancel_job':
      // console.log('setByName cancel_job received:', value);
      if (curConn) {
        curConn.cancelJob(parseInt(value));
      }
      break;
    case 'create_dir':
      // console.log('setByName create_dir received:', value);
      if (curConn) {
        value = JSON.parse(value);
        curConn.createDir(
          value.id,
          value.path,
          value.is_remote === true || value.is_remote == 'true'
        );
      }
      break;
    case 'rename_file':
      if (curConn) {
        value = JSON.parse(value);
        curConn.renameFile(
          value.id,
          value.path,
          value.new_name,
          value.is_remote === true || value.is_remote == 'true'
        );
      }
      break;
    case 'remove':
      const peers = getPeers();
      delete peers[value];
      localStorage.setItem('peers', JSON.stringify(peers));
      break;
    case 'input_key':
      // console.log('setByName input_key received:', value);
      value = JSON.parse(value);
      if (curConn) {
        // console.log('curConn is active, calling inputKey with name:', value.name, 'down:', value.down == 'true', 'press:', value.press == 'true');
        curConn.inputKey(value.name, value.down == 'true', value.press == 'true', value.alt == 'true', value.ctrl == 'true', value.shift == 'true', value.command == 'true');
      } else {
        console.warn('curConn is not active, skipped inputKey!');
      }
      break;
    case 'flutter_key_event':
      value = JSON.parse(value);
      if (curConn) {
        curConn.flutterKeyEvent(value.name, value.usb_hid, value.down == 'true', value.lock_modes);
      } else {
        console.warn('curConn is not active, skipped flutter_key_event!');
      }
      break;
    case 'input_string':
      // console.log('setByName input_string received:', value);
      if (curConn) {
        curConn.inputString(value);
      } else {
        console.warn('curConn is not active, skipped inputString!');
      }
      break;
    case 'fullscreen':
      try {
        console.log("setByName fullscreen received value:", value, "fullscreenEnabled:", document.fullscreenEnabled);
        if (value === 'Y') {
          if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch(err => {
              console.error(`Error attempting to enable full-screen mode: ${err.message}`);
            });
          }
        } else if (value === 'N') {
          if (document.fullscreenElement) {
            document.exitFullscreen();
          }
        }
      } catch (err) {
        console.error("fullscreen error:", err);
      }
      break;
    case 'send_mouse':
      let mask = 0;
      value = JSON.parse(value);
      switch (value.type) {
        case 'down':
          mask = 1;
          break;
        case 'up':
          mask = 2;
          break;
        case 'wheel':
          mask = 3;
          break;
      }
      switch (value.buttons) {
        case 'left':
          mask |= 1 << 3;
          break;
        case 'right':
          mask |= 2 << 3;
          break;
        case 'wheel':
          mask |= 4 << 3;
      }
      curConn.inputMouse(mask, parseInt(value.x || '0'), parseInt(value.y || '0'), value.alt == 'true', value.ctrl == 'true', value.shift == 'true', value.command == 'true');
      break;
    case 'option':
      value = JSON.parse(value);
      localStorage.setItem(value.name, value.value);
      break;
    case 'option:user:default':
      value = JSON.parse(value);
      localStorage.setItem('option:user:default:' + value.name, value.value);
      break;
    case 'option:local':
      value = JSON.parse(value);
      localStorage.setItem('option:local:' + value.name, value.value);
      break;
    case 'peer_option':
      value = JSON.parse(value);
      curConn.setOption(value.name, value.value);
      break;
    case 'option:session':
      value = JSON.parse(value);
      if (curConn) {
        curConn.setOption(value.name, value.value);
      }
      break;
    case 'fav':
      localStorage.setItem('fav', value);
      const favIds = JSON.parse(value || '[]');
      const allPeers = getPeers();
      const favPeers = [];
      for (const id of favIds) {
        if (!id) continue;
        const option = allPeers[id] || {};
        const info = option.info || {};
        favPeers.push({
          id: id,
          username: info.username || '',
          hostname: info.hostname || '',
          platform: info.platform || '',
          alias: option.alias || '',
          tags: option.tags || [],
          forceAlwaysRelay: option.forceAlwaysRelay || 'false',
          rdpPort: option.rdpPort || '',
          rdpUsername: option.rdpUsername || '',
          loginName: option.loginName || '',
          device_group_name: option.device_group_name || '',
        });
      }
      if (typeof onRegisteredEvent === 'function') {
        try {
          onRegisteredEvent(JSON.stringify({
            name: 'load_fav_peers',
            peers: JSON.stringify(favPeers),
          }));
        } catch (err) {
          console.error("load_fav_peers write event error:", err);
        }
      }
      break;
    case 'input_os_password':
      curConn.inputOsPassword(value);
      break;
    case 'send_chat':
      if (curConn) {
        curConn.sendChat(value);
      } else {
        console.warn('curConn is not active, skipped send_chat!');
      }
      break;
    case 'select_files':
      if (curConn) {
        const args = JSON.parse(value);
        openWebFilePicker(args.is_folder, args.path);
      } else {
        console.warn('curConn is not active, skipped select_files!');
      }
      break;
    case 'cursor':
      try {
        let cursorStyleTag = document.getElementById('flutter-custom-cursor-style');
        if (!cursorStyleTag) {
          cursorStyleTag = document.createElement('style');
          cursorStyleTag.id = 'flutter-custom-cursor-style';
          document.head.appendChild(cursorStyleTag);
        }
        if (value === 'auto') {
          document.documentElement.classList.remove('has-custom-cursor');
          cursorStyleTag.innerHTML = '';
        } else {
          const data = JSON.parse(value);
          document.documentElement.classList.add('has-custom-cursor');
          cursorStyleTag.innerHTML = `
            html.has-custom-cursor body, 
            html.has-custom-cursor flt-glass-pane:not([style*="cursor: none"]), 
            html.has-custom-cursor flt-glass-pane:not([style*="cursor: none"]) * { 
              cursor: url(${data.url}) ${data.hotx} ${data.hoty}, auto !important; 
            }
          `;
        }
      } catch (err) {
        console.error("set cursor error:", err);
      }
      break;
    case 'query_onlines':
      try {
        const ids = JSON.parse(value);
        if (typeof onRegisteredEvent === 'function') {
          onRegisteredEvent(JSON.stringify({
            name: 'callback_query_onlines',
            onlines: ids.join(','),
            offlines: '',
          }));
        }
      } catch (err) {
        console.error("query_onlines error:", err);
      }
      break;
    default:
      break;
  }
}

window.getByName = (name, arg) => {
  let v = _getByName(name, arg);
  if (typeof v == 'string' || v instanceof String) return v;
  if (v == undefined || v == null) return '';
  return JSON.stringify(v);
}

function getPeersForDart() {
  const peers = [];
  for (const [id, value] of Object.entries(getPeers())) {
    if (!id) continue;
    const tm = value['tm'];
    const info = value['info'];
    if (!tm || !info) continue;
    peers.push([tm, id, info]);
  }
  return peers.sort().reverse().map(x => x.slice(1));
}

function _getByName(name, arg) {
  switch (name) {
    case 'get_conn_status':
      return { status_num: 0 };
    case 'langs':
      return [
        ["en", "English"],
        ["zh_cn", "简体中文"],
        ["zh_tw", "繁體中文"],
        ["de", "Deutsch"],
        ["fr", "Français"],
        ["es", "Español"],
        ["it", "Italiano"],
        ["ja", "日本語"],
        ["ko", "한국어"],
        ["ru", "Русский"],
        ["pt", "Português"],
        ["tr", "Türkçe"]
      ];
    case 'peers':
      return getPeersForDart();
    case 'remote_id':
      return localStorage.getItem('remote-id');
    case 'remember':
      return curConn ? curConn.getRemember() : false;
    case 'toggle_option':
      return curConn ? (curConn.getOption(arg) || false) : false;
    case 'option':
      return localStorage.getItem(arg);
    case 'option:user:default':
      return getDefaultOption(arg);
    case 'option:local':
      return localStorage.getItem('option:local:' + arg) || '';
    case 'options':
      return {
        'custom-rendezvous-server': localStorage.getItem('custom-rendezvous-server') || '',
        'relay-server': localStorage.getItem('relay-server') || '',
        'api-server': localStorage.getItem('api-server') || '',
        'key': localStorage.getItem('key') || '',
      };
    case 'image_quality':
      return (curConn ? curConn.getImageQuality() : '') || getDefaultOption('image_quality');
    case 'translate':
      arg = JSON.parse(arg);
      return translate(arg.locale, arg.text);
    case 'peer_option':
      return curConn ? curConn.getOption(arg) : '';
    case 'option:session':
      if (curConn) {
        return curConn.getOption(arg) || getDefaultOption(arg);
      }
      return '';
    case 'option:toggle':
      // console.log('getByName option:toggle received:', arg);
      if (curConn) {
        const res = curConn.getOption(arg) ? 'true' : 'false';
        // console.log('curConn.getOption returned:', res);
        return res;
      }
      console.warn('curConn is not active, returning false for option:toggle!');
      return 'false';
    case 'fav':
      return localStorage.getItem('fav') || '[]';
    case 'load_recent_peers':
      if (typeof onRegisteredEvent === 'function') {
        try {
          const recentPeers = getRecentPeersList();
          onRegisteredEvent(JSON.stringify({
            name: 'load_recent_peers',
            peers: JSON.stringify(recentPeers),
          }));
        } catch (err) {
          console.error("load_recent_peers event error:", err);
        }
      }
      return '';
    case 'load_recent_peers_sync':
      return JSON.stringify(getRecentPeersList());
    case 'load_fav_peers':
      if (typeof onRegisteredEvent === 'function') {
        try {
          const favIds = JSON.parse(localStorage.getItem('fav') || '[]');
          const allPeers = getPeers();
          const favPeers = [];
          for (const id of favIds) {
            if (!id) continue;
            const option = allPeers[id] || {};
            const info = option.info || {};
            favPeers.push({
              id: id,
              username: info.username || '',
              hostname: info.hostname || '',
              platform: info.platform || '',
              alias: option.alias || '',
              tags: option.tags || [],
              forceAlwaysRelay: option.forceAlwaysRelay || 'false',
              rdpPort: option.rdpPort || '',
              rdpUsername: option.rdpUsername || '',
              loginName: option.loginName || '',
              device_group_name: option.device_group_name || '',
            });
          }
          onRegisteredEvent(JSON.stringify({
            name: 'load_fav_peers',
            peers: JSON.stringify(favPeers),
          }));
        } catch (err) {
          console.error("load_fav_peers event error:", err);
        }
      }
      return '';
    case 'fullscreen':
      return document.fullscreenElement ? 'Y' : 'N';
    case 'toggle_maximize':
      try {
        if (!document.fullscreenElement) {
          document.documentElement.requestFullscreen().catch(err => {
            console.error(`Error attempting to enable full-screen mode: ${err.message}`);
          });
          return 'true';
        } else {
          document.exitFullscreen();
          return 'false';
        }
      } catch (err) {
        console.error("toggle_maximize error:", err);
        return 'false';
      }
    case 'alternative_codecs':
      return JSON.stringify({
        vp8: false,
        av1: false,
        h264: false,
        h265: false
      });
    case 'app-name':
      return 'RustDesk';
    case 'platform':
      return curConn ? curConn.getPlatform() : '';
    case 'version':
      return version;
  }
  return '';
}

let opusWorker = new Worker("./libopus.js");
let pcmPlayer;

export function initAudio(channels, sampleRate) {
  pcmPlayer = newAudioPlayer(channels, sampleRate);
  opusWorker.postMessage({ channels, sampleRate });
}

export function playAudio(packet) {
  opusWorker.postMessage(packet, [packet.buffer]);
}

window.init = async () => {
  if (yuvWorker) {
    yuvWorker.onmessage = (e) => {
      window.onRgba?.(e.data.id, 0, e.data.rgba);
    }
  }
  opusWorker.onmessage = (e) => {
    pcmPlayer.feed(e.data);
  }
  loadVp9(() => { });
  await initZstd();
  document.addEventListener('fullscreenchange', (event) => {
    if (window.onFullscreenChanged) {
      window.onFullscreenChanged(!!document.fullscreenElement);
    }
  });
  console.log('init done');
  if (window.onInitFinished) {
    window.onInitFinished();
  }
}

export function getPeers() {
  try {
    let peers = JSON.parse(localStorage.getItem('peers'));
    if (!peers || Array.isArray(peers) || typeof peers !== 'object') {
      peers = {};
    }
    return new Proxy(peers, {
      get(target, prop) {
        if (prop === localStorage.getItem('remote-id')) {
          if (!(prop in target)) {
            return {
              'disable-audio': localStorage.getItem('enable-audio') === 'N',
            };
          }
          const option = target[prop];
          if (option && typeof option === 'object' && option['disable-audio'] === undefined) {
            option['disable-audio'] = localStorage.getItem('enable-audio') === 'N';
          }
          return option;
        }
        return target[prop];
      }
    });
  } catch (e) {
    return {};
  }
}

function newAudioPlayer(channels, sampleRate) {
  return new PCMPlayer({
    channels,
    sampleRate,
    flushingTime: 2000
  });
}

export function copyToClipboard(text) {
  if (window.clipboardData && window.clipboardData.setData) {
    // Internet Explorer-specific code path to prevent textarea being shown while dialog is visible.
    return window.clipboardData.setData("Text", text);

  }
  else if (document.queryCommandSupported && document.queryCommandSupported("copy")) {
    var textarea = document.createElement("textarea");
    textarea.textContent = text;
    textarea.style.position = "fixed";  // Prevent scrolling to bottom of page in Microsoft Edge.
    document.body.appendChild(textarea);
    textarea.select();
    try {
      return document.execCommand("copy");  // Security exception may be thrown by some browsers.
    }
    catch (ex) {
      console.warn("Copy to clipboard failed.", ex);
      // return prompt("Copy to clipboard: Ctrl+C, Enter", text);
    }
    finally {
      document.body.removeChild(textarea);
    }
  }
}

export function openWebFilePicker(isFolder, remotePath) {
  const input = document.createElement('input');
  input.type = 'file';
  if (isFolder) {
    input.setAttribute('webkitdirectory', '');
    input.setAttribute('directory', '');
  } else {
    input.multiple = true;
  }
  input.onchange = () => {
    if (input.files && input.files.length > 0 && window.curConn) {
      window.curConn.startUpload(input.files, remotePath);
    }
  };
  input.click();
}

export function pushTerminalResponse(resp) {
  const evt = {
    name: "terminal_response",
    ...resp
  };
  const jsonStr = JSON.stringify(evt);
  if (typeof onGlobalEvent === "function") {
    onGlobalEvent(jsonStr);
  } else if (typeof onRegisteredEvent === "function") {
    onRegisteredEvent(jsonStr);
  } else {
    console.warn("onGlobalEvent and onRegisteredEvent are not defined yet, skipped pushTerminalResponse:", resp);
  }
}