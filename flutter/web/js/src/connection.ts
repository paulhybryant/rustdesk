import Websock from "./websock";
import * as message from "./message.js";
import * as rendezvous from "./rendezvous.js";
import { loadVp9 } from "./codec";
import * as sha256 from "fast-sha256";
import * as globals from "./globals";
import { decompress, mapKey, sleep } from "./common";

const PORT = 21116;
const HOSTS = [
  "rs-sg.rustdesk.com",
  "rs-cn.rustdesk.com",
  "rs-us.rustdesk.com",
];
let HOST = localStorage.getItem("rendezvous-server") || window.location.host;
const SCHEMA: string = "ws://";

type MsgboxCallback = (type: string, title: string, text: string) => void;
type DrawCallback = (data: Uint8Array) => void;
//const cursorCanvas = document.createElement("canvas");

export default class Connection {
  _msgs: any[];
  _ws: Websock | undefined;
  _interval: any;
  _id: string;
  _hash: message.Hash | undefined;
  _msgbox: MsgboxCallback;
  _draw: DrawCallback;
  _peerInfo: message.PeerInfo | undefined;
  _firstFrame: Boolean | undefined;
  _videoDecoder: any;
  _password: Uint8Array | undefined;
  _plainPassword: string | undefined;
  _options: any;
  _videoTestSpeed: number[];
  _isFileTransfer: boolean | undefined;
  _isViewCamera: boolean | undefined;
  _isTerminal: boolean | undefined;
  _downloadJobs: Map<number, {
    path: string;
    entries: { name: string; size: number }[];
    files: {
      blocks: Uint8Array[];
      receivedSize: number;
    }[];
  }>;
  _uploadJobs: Map<number, {
    path: string;
    files: File[];
  }>;
  _modifiers: { alt: boolean; ctrl: boolean; shift: boolean; command: boolean };
  //_cursors: { [name: number]: any };

  constructor() {
    this._msgbox = globals.msgbox;
    this._draw = globals.draw;
    this._msgs = [];
    this._id = "";
    this._videoTestSpeed = [0, 0];
    this._plainPassword = undefined;
    this._isFileTransfer = false;
    this._isViewCamera = false;
    this._isTerminal = false;
    this._downloadJobs = new Map();
    this._uploadJobs = new Map();
    this._modifiers = { alt: false, ctrl: false, shift: false, command: false };
    //this._cursors = {};
  }

  async start(id: string) {
    try {
      await this._start(id);
    } catch (e: any) {
      this.msgbox(
        "error",
        "Connection Error",
        e.type == "close" ? "Reset by the peer" : String(e)
      );
    }
  }

  async _start(id: string) {
    if (!this._options) {
      this._options = globals.getPeers()[id] || {};
    }
    if (!this._password) {
      const p = this.getOption("password");
      if (p) {
        try {
          this._password = Uint8Array.from(JSON.parse("[" + p + "]"));
        } catch (e) {
          console.error(e);
        }
      }
    }
    this._interval = setInterval(() => {
      while (this._msgs.length) {
        this._ws?.sendMessage(this._msgs[0]);
        this._msgs.splice(0, 1);
      }
    }, 1);
    this.loadVideoDecoder();
    const uri = getDefaultUri();
    const ws = new Websock(uri, true);
    this._ws = ws;
    this._id = id;
    // console.log(
    //   new Date() + ": Connecting to rendezvous server: " + uri + ", for " + id
    // );
    await ws.open();
    // console.log(new Date() + ": Connected to rendezvous server");
    let conn_type = rendezvous.ConnType.DEFAULT_CONN;
    if (this._isFileTransfer) {
      conn_type = rendezvous.ConnType.FILE_TRANSFER;
    } else if (this._isViewCamera) {
      conn_type = rendezvous.ConnType.VIEW_CAMERA;
    } else if (this._isTerminal) {
      conn_type = rendezvous.ConnType.TERMINAL;
    }
    // console.log("Handshake punch_hole_request conn_type selected:", conn_type);
    const nat_type = rendezvous.NatType.SYMMETRIC;
    const punch_hole_request = rendezvous.PunchHoleRequest.fromPartial({
      id,
      licence_key: localStorage.getItem("key") || undefined,
      conn_type,
      nat_type,
      token: localStorage.getItem("access_token") || undefined,
    });
    ws.sendRendezvous({ punch_hole_request });
    const msg = (await ws.next()) as rendezvous.RendezvousMessage;
    ws.close();
    // console.log(new Date() + ": Got relay response");
    const phr = msg.punch_hole_response;
    const rr = msg.relay_response;
    if (phr) {
      if (phr?.other_failure) {
        this.msgbox("error", "Error", phr?.other_failure);
        return;
      }
      if (phr.failure != rendezvous.PunchHoleResponse_Failure.UNRECOGNIZED) {
        switch (phr?.failure) {
          case rendezvous.PunchHoleResponse_Failure.ID_NOT_EXIST:
            this.msgbox("error", "Error", "ID does not exist");
            break;
          case rendezvous.PunchHoleResponse_Failure.OFFLINE:
            this.msgbox("error", "Error", "Remote desktop is offline");
            break;
          case rendezvous.PunchHoleResponse_Failure.LICENSE_MISMATCH:
            this.msgbox("error", "Error", "Key mismatch");
            break;
          case rendezvous.PunchHoleResponse_Failure.LICENSE_OVERUSE:
            this.msgbox("error", "Error", "Key overuse");
            break;
        }
      }
    } else if (rr) {
      if (!rr.version) {
        this.msgbox("error", "Error", "Remote version is low, not support web");
        return;
      }
      await this.connectRelay(rr);
    }
  }

  async connectRelay(rr: rendezvous.RelayResponse) {
    const pk = rr.pk;
    let uri = rr.relay_server;
    const customRs = localStorage.getItem("custom-rendezvous-server") || HOST;
    let usePathBased = false;
    if (customRs.indexOf(":") > 0) {
      const port = parseInt(customRs.split(":")[1]);
      if (port === 80 || port === 443 || port === 8080 || port === 8443) {
        usePathBased = true;
      }
    }
    if (usePathBased || SCHEMA === "wss://" || window.location.protocol === "https:") {
      uri = getrUriFromRs(customRs, true);
    } else if (uri) {
      uri = getrUriFromRs(uri, true, 2);
    } else {
      uri = getDefaultUri(true);
    }
    const uuid = rr.uuid;
    // console.log(new Date() + ": Connecting to relay server: " + uri);
    const ws = new Websock(uri, false);
    await ws.open();
    // console.log(new Date() + ": Connected to relay server");
    this._ws = ws;
    const request_relay = rendezvous.RequestRelay.fromPartial({
      licence_key: localStorage.getItem("key") || undefined,
      uuid,
    });
    ws.sendRendezvous({ request_relay });
    const secure = (await this.secure(pk)) || false;
    globals.pushEvent("connection_ready", { secure, direct: false });
    await this.msgLoop();
  }

  async secure(pk: Uint8Array | undefined) {
    if (pk) {
      const RS_PK = "OeVuKk5nlHiXp+APNn0Y3pC1Iwpwn44JGqrQCsWqmBw=";
      try {
        pk = await globals.verify(pk, localStorage.getItem("key") || RS_PK);
        if (pk) {
          const idpk = message.IdPk.decode(pk);
          if (idpk.id == this._id) {
            pk = idpk.pk;
          }
        }
        if (pk?.length != 32) {
          pk = undefined;
        }
      } catch (e) {
        console.error(e);
        pk = undefined;
      }
      if (!pk)
        console.error(
          "Handshake failed: invalid public key from rendezvous server"
        );
    }
    if (!pk) {
      // send an empty message out in case server is setting up secure and waiting for first message
      const public_key = message.PublicKey.fromPartial({});
      this._ws?.sendMessage({ public_key });
      return;
    }
    const msg = (await this._ws?.next()) as message.Message;
    let signedId: any = msg?.signed_id;
    if (!signedId) {
      console.error("Handshake failed: invalid message type");
      const public_key = message.PublicKey.fromPartial({});
      this._ws?.sendMessage({ public_key });
      return;
    }
    try {
      signedId = await globals.verify(signedId.id, Uint8Array.from(pk!));
    } catch (e) {
      console.error(e);
      // fall back to non-secure connection in case pk mismatch
      console.error("pk mismatch, fall back to non-secure");
      const public_key = message.PublicKey.fromPartial({});
      this._ws?.sendMessage({ public_key });
      return;
    }
    const idpk = message.IdPk.decode(signedId);
    const id = idpk.id;
    const theirPk = idpk.pk;
    if (id != this._id!) {
      console.error("Handshake failed: sign failure");
      const public_key = message.PublicKey.fromPartial({});
      this._ws?.sendMessage({ public_key });
      return;
    }
    if (theirPk.length != 32) {
      console.error(
        "Handshake failed: invalid public box key length from peer"
      );
      const public_key = message.PublicKey.fromPartial({});
      this._ws?.sendMessage({ public_key });
      return;
    }
    const [mySk, asymmetric_value] = globals.genBoxKeyPair();
    const secret_key = globals.genSecretKey();
    const symmetric_value = globals.seal(secret_key, theirPk, mySk);
    const public_key = message.PublicKey.fromPartial({
      asymmetric_value,
      symmetric_value,
    });
    this._ws?.sendMessage({ public_key });
    this._ws?.setSecretKey(secret_key);
    // console.log("secured");
    return true;
  }

  async msgLoop() {
    while (true) {
      const msg = (await this._ws?.next()) as message.Message;
      if (msg?.hash) {
        this._hash = msg?.hash;
        if (!this._password) {
          if (this._plainPassword) {
            this.login(this._plainPassword);
          } else {
            this.msgbox("input-password", "Password Required", "");
          }
        } else {
          this.login();
        }
      } else if (msg?.test_delay) {
        const test_delay = msg?.test_delay;
        // console.log(test_delay);
        if (!test_delay.from_client) {
          this._ws?.sendMessage({ test_delay });
        }
      } else if (msg?.login_response) {
        const r = msg?.login_response;
        if (r.error) {
          if (r.error == "Wrong Password") {
            this._password = undefined;
            this.msgbox(
              "re-input-password",
              r.error,
              "Do you want to enter again?"
            );
          } else {
            this.msgbox("error", "Login Error", r.error);
          }
        } else if (r.peer_info) {
          this.handlePeerInfo(r.peer_info, false);
        }
      } else if (msg?.video_frame) {
        this.handleVideoFrame(msg?.video_frame!);
      } else if (msg?.clipboard) {
        const cb = msg?.clipboard;
        if (cb.compress) {
          const c = await decompress(cb.content);
          if (!c) continue;
          cb.content = c;
        }
        try {
          globals.copyToClipboard(new TextDecoder().decode(cb.content));
        } catch (e) {
          console.error(e);
        }
        // globals.pushEvent("clipboard", cb);
      } else if (msg?.cursor_data) {
        const cd = msg?.cursor_data;
        const c = await decompress(cd.colors);
        if (!c) continue;
        cd.colors = c;
        globals.pushEvent("cursor_data", cd);
        /*
        let ctx = cursorCanvas.getContext("2d");
        cursorCanvas.width = cd.width;
        cursorCanvas.height = cd.height;
        let imgData = new ImageData(
          new Uint8ClampedArray(c),
          cd.width,
          cd.height
        );
        ctx?.clearRect(0, 0, cd.width, cd.height);
        ctx?.putImageData(imgData, 0, 0);
        let url = cursorCanvas.toDataURL();
        const img = document.createElement("img");
        img.src = url;
        this._cursors[cd.id] = img;
        //cursorCanvas.width /= 2.;
        //cursorCanvas.height /= 2.;
        //ctx?.drawImage(img, cursorCanvas.width, cursorCanvas.height);
        url = cursorCanvas.toDataURL();
        document.body.style.cursor =
          "url(" + url + ")" + cd.hotx + " " + cd.hoty + ", default";
        console.log(document.body.style.cursor);
        */
      } else if (msg?.cursor_id) {
        globals.pushEvent("cursor_id", { id: msg?.cursor_id });
      } else if (msg?.cursor_position) {
        globals.pushEvent("cursor_position", msg?.cursor_position);
      } else if (msg?.file_response) {
        const fr = msg.file_response;
        // console.log("connection received file_response:", fr);
        if (fr.dir) {
          const val = {
            id: fr.dir.id,
            path: fr.dir.path,
            entries: fr.dir.entries.map((e: any) => ({
              entry_type: e.entry_type,
              name: e.name,
              is_hidden: e.is_hidden,
              size: e.size,
              modified_time: e.modified_time,
            })),
          };
          if (fr.dir.id > 0) {
            this._downloadJobs.set(fr.dir.id, {
              path: fr.dir.path,
              entries: fr.dir.entries.map((e: any) => ({ name: e.name, size: e.size })),
              files: fr.dir.entries.map(() => ({ blocks: [], receivedSize: 0 })),
            });
            const send_confirm = message.FileTransferSendConfirmRequest.fromPartial({
              id: fr.dir.id,
              file_num: 0,
              offset_blk: 0,
            });
            const file_action = message.FileAction.fromPartial({ send_confirm });
            this._ws?.sendMessage({ file_action });
          }
          globals.pushEvent("file_dir", {
            is_local: false,
            value: val,
          });
        } else if (fr.empty_dirs) {
          const val = {
            path: fr.empty_dirs.path,
            empty_dirs: fr.empty_dirs.empty_dirs.map((fd: any) => ({
              id: fd.id,
              path: fd.path,
              entries: fd.entries.map((e: any) => ({
                entry_type: e.entry_type,
                name: e.name,
                size: e.size,
                modified_time: e.modified_time,
              })),
            })),
          };
          globals.pushEvent("empty_dirs", {
            is_local: false,
            value: val,
          });
        } else if (fr.block) {
          const block = fr.block;
          const job = this._downloadJobs.get(block.id);
          if (job) {
            let data = block.data;
            if (block.compressed) {
              data = (await decompress(data)) || data;
            }
            const fileTracker = job.files[block.file_num];
            if (fileTracker) {
              fileTracker.blocks.push(data);
              fileTracker.receivedSize += data.length;
              globals.pushEvent("job_progress", {
                id: block.id,
                file_num: block.file_num,
                speed: 0,
                finished_size: fileTracker.receivedSize,
              });
            }
          }
        } else if (fr.done) {
          const done = fr.done;
          console.log("connection received done for id:", done.id);
          if (this._uploadJobs.has(done.id)) {
            this._uploadJobs.delete(done.id);
            globals.pushEvent("job_done", {
              id: done.id,
              file_num: done.file_num,
              speed: 0,
            });
          } else {
            const job = this._downloadJobs.get(done.id);
            if (job) {
              let downloadedAny = false;
              for (let i = 0; i < job.entries.length; i++) {
                const fileTracker = job.files[i];
                const entry = job.entries[i];
                if (fileTracker && fileTracker.blocks.length > 0 && entry) {
                  let filename = entry.name;
                  if (!filename) {
                    filename = getFilenameFromPath(job.path);
                  } else {
                    filename = getFilenameFromPath(filename);
                  }
                  const blob = new Blob(fileTracker.blocks as any, { type: "application/octet-stream" });
                  const url = window.URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = filename;
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                  window.URL.revokeObjectURL(url);
                  downloadedAny = true;
                }
              }
              if (!downloadedAny) {
                console.warn("Processing done, but no files had compiled blocks to download!");
              }
              globals.pushEvent("job_done", {
                id: done.id,
                file_num: done.file_num,
                speed: 0,
              });
              const nextFileNum = done.file_num + 1;
              if (nextFileNum < job.entries.length) {
                const send_confirm = message.FileTransferSendConfirmRequest.fromPartial({
                  id: done.id,
                  file_num: nextFileNum,
                  offset_blk: 0,
                });
                const file_action = message.FileAction.fromPartial({ send_confirm });
                this._ws?.sendMessage({ file_action });
              }
            } else {
              // It is a delete / rename / createDir job!
              globals.pushEvent("job_done", {
                id: done.id,
                file_num: done.file_num,
                speed: 0,
              });
            }
          }
        } else if (fr.error) {
          const err = fr.error;
          console.error("File transfer error:", err);
          globals.pushEvent("job_error", {
            id: err.id,
            file_num: err.file_num,
            err: err.error,
          });
        } else if (fr.digest) {
          const digest = fr.digest;
          if (digest.is_upload) {
            this.handleUploadDigest(digest);
          }
        }
      } else if (msg?.file_action) {
        const fa = msg.file_action;
        if (fa.send_confirm) {
          this.handleUploadConfirm(fa.send_confirm);
        }
      } else if (msg?.misc) {
        if (!this.handleMisc(msg?.misc)) break;
      } else if (msg?.audio_frame) {
        globals.playAudio(msg?.audio_frame.data);
      } else if (msg?.terminal_response) {
        this.handleTerminalResponse(msg.terminal_response);
      }
    }
  }

  handleTerminalResponse(tr: message.TerminalResponse) {
    if (tr.opened) {
      globals.pushTerminalResponse({
        type: "opened",
        terminal_id: tr.opened.terminal_id,
        success: tr.opened.success,
        message: tr.opened.message,
        pid: tr.opened.pid,
        service_id: tr.opened.service_id,
        persistent_sessions: tr.opened.persistent_sessions,
        replay_terminal_output: tr.opened.replay_terminal_output,
      });
    } else if (tr.data) {
      globals.pushTerminalResponse({
        type: "data",
        terminal_id: tr.data.terminal_id,
        data: Array.from(tr.data.data),
      });
    } else if (tr.closed) {
      globals.pushTerminalResponse({
        type: "closed",
        terminal_id: tr.closed.terminal_id,
        exit_code: tr.closed.exit_code,
      });
    } else if (tr.error) {
      globals.pushTerminalResponse({
        type: "error",
        terminal_id: tr.error.terminal_id,
        message: tr.error.message,
      });
    }
  }

  msgbox(type_: string, title: string, text: string) {
    this._msgbox?.(type_, title, text);
  }

  draw(frame: any) {
    globals.draw(frame, this._id);
  }

  close() {
    this._msgs = [];
    clearInterval(this._interval);
    this._ws?.close();
    this._videoDecoder?.close();
  }

  refresh() {
    const misc = message.Misc.fromPartial({ refresh_video: true });
    this._ws?.sendMessage({ misc });
  }

  sendTerminalAction(action: any) {
    this._ws?.sendMessage({ terminal_action: action });
  }

  setMsgbox(callback: MsgboxCallback) {
    this._msgbox = callback;
  }

  setDraw(callback: DrawCallback) {
    this._draw = callback;
  }

  login(password: string | undefined = undefined) {
    if (password) {
      const salt = this._hash?.salt;
      let p = hash([password, salt!]);
      this._password = p;
      const challenge = this._hash?.challenge;
      p = hash([p, challenge!]);
      this.msgbox("connecting", "Connecting...", "Logging in...");
      this._sendLoginMessage(p);
    } else {
      let p = this._password;
      if (p) {
        const challenge = this._hash?.challenge;
        p = hash([p, challenge!]);
      }
      this._sendLoginMessage(p);
    }
  }

  async reconnect() {
    this.close();
    await this.start(this._id);
  }

  _sendLoginMessage(password: Uint8Array | undefined = undefined) {
    const login_request = message.LoginRequest.fromPartial({
      username: this._id!,
      my_id: "web", // to-do
      my_name: "web", // to-do
      password,
      option: this.getOptionMessage(),
      video_ack_required: true,
      version: "1.2.3",
      my_platform: "web",
      file_transfer: this._isFileTransfer
        ? message.FileTransfer.fromPartial({ dir: "", show_hidden: false })
        : undefined,
      terminal: this._isTerminal
        ? message.Terminal.fromPartial({ service_id: "" })
        : undefined,
    });
    this._ws?.sendMessage({ login_request });
  }

  getOptionMessage(): message.OptionMessage | undefined {
    let n = 0;
    const msg = message.OptionMessage.fromPartial({});
    const q = this.getImageQualityEnum(this.getImageQuality(), true);
    const yes = message.OptionMessage_BoolOption.Yes;
    if (q != undefined) {
      msg.image_quality = q;
      n += 1;
    }
    if (this._options["show-remote-cursor"]) {
      msg.show_remote_cursor = yes;
      n += 1;
    }
    if (this._options["lock-after-session-end"]) {
      msg.lock_after_session_end = yes;
      n += 1;
    }
    if (this._options["privacy-mode"]) {
      msg.privacy_mode = yes;
      n += 1;
    }
    if (this._options["disable-audio"]) {
      msg.disable_audio = yes;
      n += 1;
    }
    if (this._options["disable-clipboard"]) {
      msg.disable_clipboard = yes;
      n += 1;
    }
    return n > 0 ? msg : undefined;
  }

  sendVideoReceived() {
    const misc = message.Misc.fromPartial({ video_received: true });
    this._ws?.sendMessage({ misc });
  }

  handleVideoFrame(vf: message.VideoFrame) {
    if (!this._firstFrame) {
      this.msgbox("", "", "");
      this._firstFrame = true;
    }
    if (vf.vp9s) {
      const dec = this._videoDecoder;
      var tm = new Date().getTime();
      var i = 0;
      const n = vf.vp9s?.frames.length;
      vf.vp9s.frames.forEach((f) => {
        dec.processFrame(f.data.slice(0).buffer, (ok: any) => {
          i++;
          if (i == n) this.sendVideoReceived();
          if (ok && dec.frameBuffer && n == i) {
            this.draw(dec.frameBuffer);
            const now = new Date().getTime();
            var elapsed = now - tm;
            this._videoTestSpeed[1] += elapsed;
            this._videoTestSpeed[0] += 1;
            if (this._videoTestSpeed[0] >= 30) {
              // console.log(
              //   "video decoder: " +
              //     parseInt(
              //       "" + this._videoTestSpeed[1] / this._videoTestSpeed[0]
              //     )
              //   );
              this._videoTestSpeed = [0, 0];
            }
          }
        });
      });
    }
  }

  handlePeerInfo(pi: message.PeerInfo, isCached = false) {
    this._peerInfo = pi;
    if (this._isFileTransfer) {
      globals.pushEvent("peer_info", pi);
      if (!isCached) {
        console.log("Pushed web_session_ready event!");
        globals.pushEvent("web_session_ready", { id: this._id });
      }
      return;
    }
    if (this._isTerminal) {
      globals.pushEvent("peer_info", pi);
      return;
    }
    if (pi.displays.length == 0) {
      this.msgbox("error", "Remote Error", "No Display");
      return;
    }
    this.msgbox("success", "Successful", "Connected, waiting for image...");
    globals.pushEvent("peer_info", pi);
    const p = this.shouldAutoLogin();
    if (p) this.inputOsPassword(p);
    const username = this.getOption("info")?.username;
    if (username && !pi.username) pi.username = username;
    this.setOption("info", pi);
    if (this.getRemember()) {
      if (this._password?.length) {
        const p = this._password.toString();
        if (p != this.getOption("password")) {
          this.setOption("password", p);
          console.log("remember password of " + this._id);
        }
      }
    } else {
      this.setOption("password", undefined);
    }
  }

  shouldAutoLogin(): string {
    const l = this.getOption("lock-after-session-end");
    const a = !!this.getOption("auto-login");
    const p = this.getOption("os-password");
    if (p && l && a) {
      return p;
    }
    return "";
  }

  handleMisc(misc: message.Misc) {
    if (misc.audio_format) {
      globals.initAudio(
        misc.audio_format.channels,
        misc.audio_format.sample_rate
      );
    } else if (misc.chat_message) {
      globals.pushEvent("chat_client_mode", { text: misc.chat_message.text });
    } else if (misc.permission_info) {
      const p = misc.permission_info;
      console.info("Change permission " + p.permission + " -> " + p.enabled);
      let name;
      switch (p.permission) {
        case message.PermissionInfo_Permission.Keyboard:
          name = "keyboard";
          break;
        case message.PermissionInfo_Permission.Clipboard:
          name = "clipboard";
          break;
        case message.PermissionInfo_Permission.Audio:
          name = "audio";
          break;
        default:
          return;
      }
      globals.pushEvent("permission", { [name]: p.enabled });
    } else if (misc.switch_display) {
      this.loadVideoDecoder();
      globals.pushEvent("switch_display", misc.switch_display);
    } else if (misc.close_reason) {
      this.msgbox("error", "Connection Error", misc.close_reason);
      this.close();
      return false;
    }
    return true;
  }

  getRemember(): Boolean {
    return this._options["remember"] || false;
  }

  setRemember(v: Boolean) {
    this.setOption("remember", v);
  }

  getOption(name: string): any {
    return this._options[name];
  }

  setOption(name: string, value: any) {
    if (value == undefined) {
      delete this._options[name];
    } else {
      this._options[name] = value;
    }
    this._options["tm"] = new Date().getTime();
    const peers = globals.getPeers();
    peers[this._id] = this._options;
    localStorage.setItem("peers", JSON.stringify(peers));
  }

  inputKey(
    name: string,
    down: boolean,
    press: boolean,
    alt: Boolean,
    ctrl: Boolean,
    shift: Boolean,
    command: Boolean
  ) {
    const key_event = mapKey(name, globals.isDesktop());
    if (!key_event) return;
    if (alt && (name == "VK_MENU" || name == "RAlt")) {
      alt = false;
    }
    if (ctrl && (name == "VK_CONTROL" || name == "RControl")) {
      ctrl = false;
    }
    if (shift && (name == "VK_SHIFT" || name == "RShift")) {
      shift = false;
    }
    if (command && (name == "Meta" || name == "RWin")) {
      command = false;
    }
    key_event.down = down;
    key_event.press = press;
    key_event.modifiers = this.getMod(alt, ctrl, shift, command);
    this._ws?.sendMessage({ key_event });
  }

  flutterKeyEvent(
    name: string,
    usbHid: number,
    down: boolean,
    lockModes: number
  ) {
    const mod = getModifierControlKey(usbHid);
    if (mod === message.ControlKey.Shift) this._modifiers.shift = down;
    if (mod === message.ControlKey.Control) this._modifiers.ctrl = down;
    if (mod === message.ControlKey.Alt) this._modifiers.alt = down;
    if (mod === message.ControlKey.Meta) this._modifiers.command = down;

    const control_key = usbHidToControlKey(usbHid);
    if (control_key !== undefined) {
      const key_event = message.KeyEvent.fromPartial({
        down: down,
        press: false,
        control_key: control_key,
        mode: message.KeyboardMode.Legacy,
        modifiers: this.getMod(this._modifiers.alt, this._modifiers.ctrl, this._modifiers.shift, this._modifiers.command),
      });
      this._ws?.sendMessage({ key_event });
    } else {
      let charName = name;
      if (!charName) {
        charName = usbHidToCharacter(usbHid) || "";
      }
      if (charName) {
        const isHotkey = this._modifiers.ctrl || this._modifiers.alt || this._modifiers.command;
        if (isHotkey) {
          const key_event = message.KeyEvent.fromPartial({
            down: down,
            press: false,
            chr: charName.toLowerCase().charCodeAt(0),
            mode: message.KeyboardMode.Legacy,
            modifiers: this.getMod(this._modifiers.alt, this._modifiers.ctrl, this._modifiers.shift, this._modifiers.command),
          });
          this._ws?.sendMessage({ key_event });
        } else if (down) {
          const key_event = message.KeyEvent.fromPartial({
            down: down,
            press: false,
            seq: charName,
            mode: message.KeyboardMode.Translate,
            modifiers: this.getMod(this._modifiers.alt, this._modifiers.ctrl, this._modifiers.shift, this._modifiers.command),
          });
          this._ws?.sendMessage({ key_event });
        }
      }
    }
  }

  ctrlAltDel() {
    const key_event = message.KeyEvent.fromPartial({ down: true });
    if (this._peerInfo?.platform == "Windows") {
      key_event.control_key = message.ControlKey.CtrlAltDel;
    } else {
      key_event.control_key = message.ControlKey.Delete;
      key_event.modifiers = this.getMod(true, true, false, false);
    }
    this._ws?.sendMessage({ key_event });
  }

  inputString(seq: string) {
    const key_event = message.KeyEvent.fromPartial({ seq });
    this._ws?.sendMessage({ key_event });
  }

  switchDisplay(display: number) {
    const switch_display = message.SwitchDisplay.fromPartial({ display });
    const misc = message.Misc.fromPartial({ switch_display });
    this._ws?.sendMessage({ misc });
  }

  changeResolution(display: number, width: number, height: number) {
    console.log("connection changeResolution called for display:", display, "w:", width, "h:", height);
    const resolution = message.Resolution.fromPartial({ width, height });
    const change_display_resolution = message.DisplayResolution.fromPartial({
      display,
      resolution,
    });
    const misc = message.Misc.fromPartial({ change_display_resolution });
    this._ws?.sendMessage({ misc });
  }

  readDir(path: string, include_hidden: boolean) {
    console.log("connection readDir called for path:", path, "include_hidden:", include_hidden);
    const read_dir = message.ReadDir.fromPartial({ path, include_hidden });
    const file_action = message.FileAction.fromPartial({ read_dir });
    this._ws?.sendMessage({ file_action });
  }

  async inputOsPassword(seq: string) {
    this.inputMouse();
    await sleep(50);
    this.inputMouse(0, 3, 3);
    await sleep(50);
    this.inputMouse(1 | (1 << 3));
    this.inputMouse(2 | (1 << 3));
    await sleep(1200);
    const key_event = message.KeyEvent.fromPartial({ press: true, seq });
    this._ws?.sendMessage({ key_event });
  }

  lockScreen() {
    const key_event = message.KeyEvent.fromPartial({
      down: true,
      control_key: message.ControlKey.LockScreen,
    });
    this._ws?.sendMessage({ key_event });
  }

  getMod(alt: Boolean, ctrl: Boolean, shift: Boolean, command: Boolean) {
    const mod: message.ControlKey[] = [];
    if (alt) mod.push(message.ControlKey.Alt);
    if (ctrl) mod.push(message.ControlKey.Control);
    if (shift) mod.push(message.ControlKey.Shift);
    if (command) mod.push(message.ControlKey.Meta);
    return mod;
  }

  inputMouse(
    mask: number = 0,
    x: number = 0,
    y: number = 0,
    alt: Boolean = false,
    ctrl: Boolean = false,
    shift: Boolean = false,
    command: Boolean = false
  ) {
    const mouse_event = message.MouseEvent.fromPartial({
      mask,
      x,
      y,
      modifiers: this.getMod(alt, ctrl, shift, command),
    });
    this._ws?.sendMessage({ mouse_event });
  }

  toggleOption(name: string) {
    const v = !this._options[name];
    const option = message.OptionMessage.fromPartial({});
    const v2 = v
      ? message.OptionMessage_BoolOption.Yes
      : message.OptionMessage_BoolOption.No;
    let hasOption = true;
    switch (name) {
      case "show-remote-cursor":
        option.show_remote_cursor = v2;
        break;
      case "disable-audio":
        option.disable_audio = v2;
        break;
      case "disable-clipboard":
        option.disable_clipboard = v2;
        break;
      case "lock-after-session-end":
        option.lock_after_session_end = v2;
        break;
      case "privacy-mode":
        option.privacy_mode = v2;
        break;
      case "block-input":
        option.block_input = message.OptionMessage_BoolOption.Yes;
        break;
      case "unblock-input":
        option.block_input = message.OptionMessage_BoolOption.No;
        break;
      default:
        hasOption = false;
        break;
    }
    if (name.indexOf("block-input") < 0) this.setOption(name, v);
    if (hasOption) {
      const misc = message.Misc.fromPartial({ option });
      this._ws?.sendMessage({ misc });
    }
  }

  getImageQuality() {
    return this.getOption("image-quality");
  }

  getImageQualityEnum(
    value: string,
    ignoreDefault: Boolean
  ): message.ImageQuality | undefined {
    switch (value) {
      case "low":
        return message.ImageQuality.Low;
      case "best":
        return message.ImageQuality.Best;
      case "balanced":
        return ignoreDefault ? undefined : message.ImageQuality.Balanced;
      default:
        return undefined;
    }
  }

  setImageQuality(value: string) {
    this.setOption("image-quality", value);
    const image_quality = this.getImageQualityEnum(value, false);
    if (image_quality == undefined) return;
    const option = message.OptionMessage.fromPartial({ image_quality });
    const misc = message.Misc.fromPartial({ option });
    this._ws?.sendMessage({ misc });
  }

  loadVideoDecoder() {
    this._videoDecoder?.close();
    loadVp9((decoder: any) => {
      this._videoDecoder = decoder;
      // console.log("vp9 loaded");
      // console.log(decoder);
    });
  }

  sendFiles(
    id: number,
    path: string,
    to: string,
    file_num: number,
    include_hidden: boolean,
    is_remote: boolean,
    is_dir: boolean
  ) {
    if (is_remote) {
      console.log(`connection sendFiles (download) called for id: ${id}, path: ${path}`);
      const send = message.FileTransferSendRequest.fromPartial({
        id,
        path,
        include_hidden,
        file_num,
        file_type: message.FileTransferSendRequest_FileType.Generic,
      });
      const file_action = message.FileAction.fromPartial({ send });
      this._ws?.sendMessage({ file_action });
    } else {
      console.warn("Upload (client to server) is not supported on web client yet!");
    }
  }

  async startUpload(filesList: FileList, remotePath: string) {
    const files = Array.from(filesList);
    if (files.length === 0) return;

    const jobId = Math.floor(Math.random() * 1000000) + 1;
    this._uploadJobs.set(jobId, {
      path: remotePath,
      files,
    });

    console.log(`Starting upload job ${jobId} to ${remotePath} with ${files.length} files`);

    const entries = files.map((f: any) => {
      let name = f.webkitRelativePath || f.name;
      name = name.replace(/\\/g, "/");
      return message.FileEntry.fromPartial({
        entry_type: message.FileType.File,
        name,
        size: f.size,
        modified_time: Math.floor(f.lastModified / 1000),
        is_hidden: false,
      });
    });

    const totalSize = files.reduce((acc, f) => acc + f.size, 0);

    const receive = message.FileTransferReceiveRequest.fromPartial({
      id: jobId,
      path: remotePath,
      files: entries,
      file_num: entries.length,
      total_size: totalSize,
    });

    const file_action = message.FileAction.fromPartial({ receive });
    this._ws?.sendMessage({ file_action });

    const firstFile = files[0];
    if (firstFile) {
      const digest = message.FileTransferDigest.fromPartial({
        id: jobId,
        file_num: 0,
        last_modified: Math.floor(firstFile.lastModified / 1000),
        file_size: firstFile.size,
        is_resume: true,
      });
      const file_response = message.FileResponse.fromPartial({ digest });
      this._ws?.sendMessage({ file_response });
    }

    const val = {
      id: jobId,
      path: remotePath,
      entries: entries.map((e: any) => ({
        entry_type: e.entry_type,
        name: e.name,
        is_hidden: e.is_hidden,
        size: e.size,
        modified_time: e.modified_time,
      })),
    };

    globals.pushEvent("job_init", {
      is_local: true,
      value: val,
    });
  }

  async handleUploadConfirm(sc: any) {
    const jobId = sc.id;
    const fileNum = sc.file_num;
    console.log(`handleUploadConfirm called for job: ${jobId}, file_num: ${fileNum}`);

    const job = this._uploadJobs.get(jobId);
    if (!job) {
      console.warn("Upload job not found for confirm id:", jobId);
      return;
    }

    const file = job.files[fileNum];
    if (!file) {
      console.warn(`File not found at index ${fileNum} in job ${jobId}`);
      return;
    }

    this.runUploadLoop(jobId, fileNum, file);
  }

  async handleUploadDigest(digest: any) {
    const jobId = digest.id;
    const fileNum = digest.file_num;
    console.log(`handleUploadDigest called for job: ${jobId}, file_num: ${fileNum}`);

    const job = this._uploadJobs.get(jobId);
    if (!job) {
      console.warn("Upload job not found for digest id:", jobId);
      return;
    }

    const file = job.files[fileNum];
    if (!file) {
      console.warn(`File not found at index ${fileNum} in job ${jobId}`);
      return;
    }

    const send_confirm = message.FileTransferSendConfirmRequest.fromPartial({
      id: jobId,
      file_num: fileNum,
      offset_blk: 0,
    });
    const file_action = message.FileAction.fromPartial({ send_confirm });
    this._ws?.sendMessage({ file_action });

    this.runUploadLoop(jobId, fileNum, file);
  }

  async runUploadLoop(jobId: number, fileNum: number, file: File) {
    console.log(`Starting runUploadLoop for job: ${jobId}, file_num: ${fileNum}, size: ${file.size}`);
    const CHUNK_SIZE = 128 * 1024;
    let offset = 0;

    try {
      while (offset < file.size) {
        if (!this._uploadJobs.has(jobId) || !this._ws) {
          console.log(`Upload job ${jobId} was cancelled or connection closed. Aborting loop.`);
          return;
        }

        const chunk = file.slice(offset, offset + CHUNK_SIZE);
        const buffer = await chunk.arrayBuffer();
        const data = new Uint8Array(buffer);

        const block = message.FileTransferBlock.fromPartial({
          id: jobId,
          file_num: fileNum,
          data,
          compressed: false,
        });

        const file_response = message.FileResponse.fromPartial({ block });
        this._ws?.sendMessage({ file_response });

        offset += data.length;

        globals.pushEvent("job_progress", {
          id: jobId,
          file_num: fileNum,
          speed: 0,
          finished_size: offset,
        });

        await sleep(10);
      }

      const done = message.FileTransferDone.fromPartial({
        id: jobId,
        file_num: fileNum,
      });
      const file_response = message.FileResponse.fromPartial({ done });
      this._ws?.sendMessage({ file_response });

      console.log(`Finished uploading file index ${fileNum} of job ${jobId}`);

      globals.pushEvent("job_done", {
        id: jobId,
        file_num: fileNum,
        speed: 0,
      });

      const nextFileNum = fileNum + 1;
      const job = this._uploadJobs.get(jobId);
      if (job && nextFileNum < job.files.length) {
        const nextFile = job.files[nextFileNum];
        if (nextFile) {
          const digest = message.FileTransferDigest.fromPartial({
            id: jobId,
            file_num: nextFileNum,
            last_modified: Math.floor(nextFile.lastModified / 1000),
            file_size: nextFile.size,
            is_resume: true,
          });
          const file_response = message.FileResponse.fromPartial({ digest });
          this._ws?.sendMessage({ file_response });
        }
      }

    } catch (err) {
      console.error(`Error during file upload loop for job: ${jobId}, file: ${fileNum}`, err);
      const error = message.FileTransferError.fromPartial({
        id: jobId,
        file_num: fileNum,
        error: String(err),
      });
      const file_response = message.FileResponse.fromPartial({ error });
      this._ws?.sendMessage({ file_response });

      globals.pushEvent("job_error", {
        id: jobId,
        file_num: fileNum,
        err: String(err),
      });
    }
  }

  removeFile(id: number, path: string, file_num: number, is_remote: boolean) {
    console.log(`connection removeFile called for id: ${id}, path: ${path}, is_remote: ${is_remote}`);
    if (is_remote) {
      const remove_file = message.FileRemoveFile.fromPartial({
        id,
        path,
        file_num,
      });
      const file_action = message.FileAction.fromPartial({ remove_file });
      this._ws?.sendMessage({ file_action });
    } else {
      console.warn("Local file deletion is not supported from web interface!");
    }
  }

  readDirToRemoveRecursive(id: number, path: string, is_remote: boolean, show_hidden: boolean) {
    console.log(`connection readDirToRemoveRecursive called for id: ${id}, path: ${path}, is_remote: ${is_remote}`);
    if (is_remote) {
      const all_files = message.ReadAllFiles.fromPartial({
        id,
        path,
        include_hidden: show_hidden,
      });
      const file_action = message.FileAction.fromPartial({ all_files });
      this._ws?.sendMessage({ file_action });
    } else {
      console.warn("Local recursive directory reading is not supported!");
    }
  }

  removeAllEmptyDirs(id: number, path: string, is_remote: boolean) {
    console.log(`connection removeAllEmptyDirs called for id: ${id}, path: ${path}, is_remote: ${is_remote}`);
    if (is_remote) {
      const remove_dir = message.FileRemoveDir.fromPartial({
        id,
        path,
        recursive: true,
      });
      const file_action = message.FileAction.fromPartial({ remove_dir });
      this._ws?.sendMessage({ file_action });
    } else {
      console.warn("Local empty directory removal is not supported!");
    }
  }

  cancelJob(id: number) {
    console.log(`connection cancelJob called for id: ${id}`);
    const cancel = message.FileTransferCancel.fromPartial({
      id,
    });
    const file_action = message.FileAction.fromPartial({ cancel });
    this._ws?.sendMessage({ file_action });
  }

  createDir(id: number, path: string, is_remote: boolean) {
    console.log(`connection createDir called for id: ${id}, path: ${path}, is_remote: ${is_remote}`);
    if (is_remote) {
      const create = message.FileDirCreate.fromPartial({
        id,
        path,
      });
      const file_action = message.FileAction.fromPartial({ create });
      this._ws?.sendMessage({ file_action });
    } else {
      console.warn("Local directory creation is not supported!");
    }
  }

  renameFile(id: number, path: string, newName: string, is_remote: boolean) {
    console.log(`connection renameFile called for id: ${id}, path: ${path}, newName: ${newName}, is_remote: ${is_remote}`);
    if (is_remote) {
      const rename = message.FileRename.fromPartial({
        id,
        path,
        new_name: newName,
      });
      const file_action = message.FileAction.fromPartial({ rename });
      this._ws?.sendMessage({ file_action });
    } else {
      console.warn("Local rename is not supported!");
    }
  }

  getPlatform(): string {
    return this._peerInfo?.platform || "";
  }

  sendChat(text: string) {
    const chat_message = message.ChatMessage.fromPartial({ text });
    const misc = message.Misc.fromPartial({ chat_message });
    this._ws?.sendMessage({ misc });
  }
}

function getFilenameFromPath(path: string): string {
  if (!path) return "downloaded_file";
  const sanitized = path.replace(/[\r\n]/g, "").trim();
  const parts = sanitized.split(/[/\\]/);
  return (parts[parts.length - 1] || "downloaded_file").trim();
}

function testDelay() {
  var nearest = "";
  HOSTS.forEach((host) => {
    const now = new Date().getTime();
    new Websock(getrUriFromRs(host), true).open().then(() => {
      console.log("latency of " + host + ": " + (new Date().getTime() - now));
      if (!nearest) {
        HOST = host;
        localStorage.setItem("rendezvous-server", host);
      }
    });
  });
}

// testDelay();

function getDefaultUri(isRelay: Boolean = false): string {
  const host = localStorage.getItem("custom-rendezvous-server");
  return getrUriFromRs(host || HOST, isRelay);
}

function getrUriFromRs(
  uri: string,
  isRelay: Boolean = false,
  roffset: number = 0
): string {
  const suffix = isRelay ? "/ws/relay" : "/ws/id";

  // 1) Scheme present
  if (/^[a-z]+:\/\//i.test(uri)) {
    const url = new URL(uri);
    const wsProtocol = SCHEMA;
    const host = url.host;
    let pathname = url.pathname;
    if (pathname === "/" || pathname === "") {
      pathname = suffix;
    }
    return `${wsProtocol}://${host}${pathname}${url.search}${url.hash}`;
  }

  // 2) Same host as the webpage -> always use path-based routing
  const pageHost = window.location.host;
  const pageHostname = window.location.hostname;
  if (uri === pageHost || uri === pageHostname || uri.startsWith(pageHost + "/") || uri.startsWith(pageHostname + "/")) {
    const cleanUri = uri.split("/")[0];
    return SCHEMA + cleanUri + suffix;
  }

  // 3) Other host:port -> standard RustDesk port mapping
  if (uri.indexOf(":") > 0) {
    const tmp = uri.split(":");
    const port = parseInt(tmp[1]);
    if (port === 21116) {
      return SCHEMA + tmp[0] + ":" + (isRelay ? 21119 : 21118);
    }
    if (port === 80 || port === 443 || port === 8080 || port === 8443) {
      return SCHEMA + tmp[0] + ":" + port + suffix;
    }
    return SCHEMA + tmp[0] + ":" + (port + (isRelay ? roffset || 3 : 2));
  }

  // 4) Hostname only -> append suffix
  return SCHEMA + uri + suffix;
}

function hash(datas: (string | Uint8Array)[]): Uint8Array {
  const hasher = new sha256.Hash();
  datas.forEach((data) => {
    if (typeof data == "string") {
      data = new TextEncoder().encode(data);
    }
    return hasher.update(data);
  });
  return hasher.digest();
}

function getModifierControlKey(usbHid: number): message.ControlKey | undefined {
  switch (usbHid) {
    case 224: // Left Control
    case 228: // Right Control
      return message.ControlKey.Control;
    case 225: // Left Shift
    case 229: // Right Shift
      return message.ControlKey.Shift;
    case 226: // Left Alt
    case 230: // Right Alt
      return message.ControlKey.Alt;
    case 227: // Left GUI
    case 231: // Right GUI
      return message.ControlKey.Meta;
  }
  return undefined;
}

function usbHidToControlKey(usbHid: number): message.ControlKey | undefined {
  const mod = getModifierControlKey(usbHid);
  if (mod !== undefined) return mod;

  switch (usbHid) {
    case 0x2a: // Backspace
      return message.ControlKey.Backspace;
    case 0x2b: // Tab
      return message.ControlKey.Tab;
    case 0x28: // Return/Enter
      return message.ControlKey.Return;
    case 0x29: // Escape
      return message.ControlKey.Escape;
    case 0x2c: // Space
      return message.ControlKey.Space;
    case 0x4f: // Right Arrow
      return message.ControlKey.RightArrow;
    case 0x50: // Left Arrow
      return message.ControlKey.LeftArrow;
    case 0x51: // Down Arrow
      return message.ControlKey.DownArrow;
    case 0x52: // Up Arrow
      return message.ControlKey.UpArrow;
    case 0x4c: // Delete
      return message.ControlKey.Delete;
    case 0x4a: // Home
      return message.ControlKey.Home;
    case 0x4d: // End
      return message.ControlKey.End;
    case 0x4b: // PageUp
      return message.ControlKey.PageUp;
    case 0x4e: // PageDown
      return message.ControlKey.PageDown;
    case 0x39: // CapsLock
      return message.ControlKey.CapsLock;
    
    // Function keys (F1 - F12)
    case 0x3a: return message.ControlKey.F1;
    case 0x3b: return message.ControlKey.F2;
    case 0x3c: return message.ControlKey.F3;
    case 0x3d: return message.ControlKey.F4;
    case 0x3e: return message.ControlKey.F5;
    case 0x3f: return message.ControlKey.F6;
    case 0x40: return message.ControlKey.F7;
    case 0x41: return message.ControlKey.F8;
    case 0x42: return message.ControlKey.F9;
    case 0x43: return message.ControlKey.F10;
    case 0x44: return message.ControlKey.F11;
    case 0x45: return message.ControlKey.F12;
  }
  return undefined;
}

function usbHidToCharacter(usbHid: number): string | undefined {
  if (usbHid >= 4 && usbHid <= 29) {
    // Key A to Key Z
    return String.fromCharCode(97 + (usbHid - 4)); // 'a' is 97
  }
  if (usbHid >= 30 && usbHid <= 38) {
    // Digit 1 to 9
    return String.fromCharCode(49 + (usbHid - 30)); // '1' is 49
  }
  if (usbHid === 39) {
    return "0";
  }
  switch (usbHid) {
    case 45: return "-";
    case 46: return "=";
    case 47: return "[";
    case 48: return "]";
    case 49: return "\\";
    case 51: return ";";
    case 52: return "'";
    case 53: return "`";
    case 54: return ",";
    case 55: return ".";
    case 56: return "/";
  }
  return undefined;
}
