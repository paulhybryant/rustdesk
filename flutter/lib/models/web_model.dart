// ignore_for_file: avoid_web_libraries_in_flutter

import 'dart:convert';
import 'dart:js_interop';
import 'dart:js_interop_unsafe';
import 'dart:typed_data';
import 'dart:js';
import 'dart:html';
import 'dart:async';
import 'dart:ui' as ui;
import 'dart:ui_web' as ui_web;

import 'package:flutter/foundation.dart';
import 'package:flutter_hbb/common/widgets/login.dart';
import 'package:flutter_hbb/models/state_model.dart';
import 'package:flutter_hbb/models/web_video_frame_queue.dart';

import 'package:flutter_hbb/web/bridge.dart';
import 'package:flutter_hbb/common.dart';
import 'package:uuid/uuid.dart';

final List<StreamSubscription<MouseEvent>> mouseListeners = [];
final List<StreamSubscription<KeyboardEvent>> keyListeners = [];

// WebCodecs VideoFrames handed over from js/src/webcodecs.js arrive as plain
// interop objects (the package language version predates extension types).
// This side owns each frame and must close it quickly: hardware decoders
// stall once their small output frame pool is exhausted.
int _videoFrameWidth(JSObject frame) =>
    frame.getProperty<JSNumber>('displayWidth'.toJS).toDartInt;
int _videoFrameHeight(JSObject frame) =>
    frame.getProperty<JSNumber>('displayHeight'.toJS).toDartInt;
void _closeVideoFrame(JSObject frame) {
  try {
    frame.callMethod<JSAny?>('close'.toJS);
  } catch (error) {
    debugPrint('VideoFrame.close failed: $error');
  }
}

typedef HandleEvent = Future<void> Function(Map<String, dynamic> evt);

class PlatformFFI {
  final _eventHandlers = <String, Map<String, HandleEvent>>{};
  final RustdeskImpl _ffiBind = RustdeskImpl();
  void Function(Map<String, dynamic>)? _globalEventCallback;
  final List<Map<String, dynamic>> _cachedEvents = [];

  static String getByName(String name, [String arg = '']) {
    return context.callMethod('getByName', [name, arg]);
  }

  static void setByName(String name, [String value = '']) {
    context.callMethod('setByName', [name, value]);
  }

  PlatformFFI._() {
    _videoFrameQueue = WebVideoFrameQueue(
      importFrame: _importVideoFrame,
      closeFrame: _closeVideoFrame,
      disposeImage: (image) => image.dispose(),
      onImportError: _handleVideoFrameImportError,
      onCallbackError: _handleVideoImageCallbackError,
    );
    window.document.addEventListener(
        'visibilitychange',
        (event) => {
              stateGlobal.isWebVisible =
                  window.document.visibilityState == 'visible'
            });
  }

  static final PlatformFFI instance = PlatformFFI._();

  static get localeName => window.navigator.language;
  RustdeskImpl get ffiBind => _ffiBind;

  static Future<String> getVersion() async {
    throw UnimplementedError();
  }

  bool registerEventHandler(
      String eventName, String handlerName, HandleEvent handler,
      {bool replace = false}) {
    debugPrint('registerEventHandler $eventName $handlerName');
    var handlers = _eventHandlers[eventName];
    if (handlers == null) {
      _eventHandlers[eventName] = {handlerName: handler};
      return true;
    } else {
      if (!replace && handlers.containsKey(handlerName)) {
        return false;
      } else {
        handlers[handlerName] = handler;
        return true;
      }
    }
  }

  void unregisterEventHandler(String eventName, String handlerName) {
    debugPrint('unregisterEventHandler $eventName $handlerName');
    var handlers = _eventHandlers[eventName];
    if (handlers != null) {
      handlers.remove(handlerName);
    }
  }

  Future<bool> tryHandle(Map<String, dynamic> evt) async {
    final name = evt['name'];
    if (name != null) {
      final handlers = _eventHandlers[name];
      if (handlers != null) {
        if (handlers.isNotEmpty) {
          for (var handler in handlers.values) {
            await handler(evt);
          }
          return true;
        }
      }
    }
    return false;
  }

  String translate(String name, String locale) =>
      _ffiBind.translate(name: name, locale: locale);

  Uint8List? getRgba(SessionID sessionId, int display, int bufSize) {
    throw UnimplementedError();
  }

  int getRgbaSize(SessionID sessionId, int display) =>
      _ffiBind.sessionGetRgbaSize(sessionId: sessionId, display: display);
  void nextRgba(SessionID sessionId, int display) =>
      _ffiBind.sessionNextRgba(sessionId: sessionId, display: display);
  void registerPixelbufferTexture(SessionID sessionId, int display, int ptr) =>
      _ffiBind.sessionRegisterPixelbufferTexture(
          sessionId: sessionId, display: display, ptr: ptr);
  void registerGpuTexture(SessionID sessionId, int display, int ptr) =>
      _ffiBind.sessionRegisterGpuTexture(
          sessionId: sessionId, display: display, ptr: ptr);

  Future<void> init(String appType) async {
    Completer completer = Completer();
    context["onInitFinished"] = () {
      completer.complete();
    };
    context['dialog'] = (type, title, text) {
      final uuid = Uuid();
      msgBox(SessionID(uuid.v4()), type, title, text, '', gFFI.dialogManager);
    };
    context['loginDialog'] = () {
      loginDialog();
    };
    context['closeConnection'] = () {
      gFFI.dialogManager.dismissAll();
      closeConnection();
    };
    context.callMethod('init');
    version = getByName('version');
    window.onContextMenu.listen((event) {
      event.preventDefault();
    });

    context['onRegisteredEvent'] = (String message) async {
      try {
        Map<String, dynamic> event = json.decode(message);
        if (!await tryHandle(event)) {
          if (_globalEventCallback != null) {
            _globalEventCallback!(event);
          } else {
            _cachedEvents.add(event);
          }
        }
      } catch (e) {
        print('json.decode fail(): $e');
      }
    };
    return completer.future;
  }

  void setEventCallback(void Function(Map<String, dynamic>) fun) {
    _globalEventCallback = fun;
    context["onGlobalEvent"] = (String message) {
      try {
        Map<String, dynamic> event = json.decode(message);
        fun(event);
      } catch (e) {
        print('json.decode fail(): $e');
      }
    };
    for (var event in _cachedEvents) {
      fun(event);
    }
    _cachedEvents.clear();
  }

  final _rgbaCallbacks = <String, void Function(int, Uint8List)>{};

  void setRgbaCallback(String id, void Function(int, Uint8List) fun) {
    _rgbaCallbacks[id] = fun;
    context["onRgba"] = (Object? peerId, Object? display, Object? rgba) {
      if (rgba != null && peerId != null && display != null) {
        final String? idStr = peerId is String ? peerId : peerId.toString();
        final int? dispInt = display is int ? display : (display is num ? display.toInt() : null);
        Uint8List? bytes;
        if (rgba is Uint8List) {
          bytes = rgba;
        } else {
          try {
            final jsObj = rgba as JSObject;
            final dartBuffer = jsObj.buffer.toDart;
            bytes = dartBuffer.asUint8List(jsObj.byteOffset, jsObj.byteLength);
          } catch (e) {
            debugPrint("Failed to convert rgba argument to Uint8List: $e");
          }
        }
        if (idStr != null && dispInt != null && bytes != null) {
          final callback = _rgbaCallbacks[idStr];
          if (callback != null) {
            callback(dispInt, bytes);
          }
        }
      }
    };
  }

  late final WebVideoFrameQueue<JSObject, ui.Image> _videoFrameQueue;

  // Zero-readback video path: the JS decoder hands decoded VideoFrames here
  // (checking typeof window.onVideoFrame before every frame), and the engine
  // imports them GPU-to-GPU via createImageBitmap. Unregistering the JS global
  // reverts the JS side to the RGBA readback path.
  void setVideoFrameCallback(
      Future<void> Function(int, ui.Image, bool Function()) fun) {
    _videoFrameQueue.beginSession(fun);
    if (!_videoFrameQueue.isEnabled) return;
    globalContext.setProperty(
      'onVideoFrame'.toJS,
      ((JSNumber display, JSObject frame) {
        _videoFrameQueue.submit(display.toDartInt, frame);
      }).toJS,
    );
  }

  void clearVideoFrameCallback() {
    _videoFrameQueue.endSession();
    globalContext.setProperty('onVideoFrame'.toJS, null);
  }

  Future<ui.Image> _importVideoFrame(JSObject frame) async {
    return await ui_web.createImageFromTextureSource(frame,
        width: _videoFrameWidth(frame), height: _videoFrameHeight(frame));
  }

  void _handleVideoFrameImportError(Object error, StackTrace stackTrace) {
    debugPrintStack(
        label: 'createImageFromTextureSource failed, using RGBA path: $error',
        stackTrace: stackTrace);
    globalContext.setProperty('onVideoFrame'.toJS, null);
  }

  void _handleVideoImageCallbackError(Object error, StackTrace stackTrace) {
    debugPrintStack(
        label: 'video image callback error: $error', stackTrace: stackTrace);
  }

  void startDesktopWebListener() {
    mouseListeners.add(
        window.document.onContextMenu.listen((evt) => evt.preventDefault()));
  }

  void stopDesktopWebListener() {
    for (var ml in mouseListeners) {
      ml.cancel();
    }
    mouseListeners.clear();
    for (var kl in keyListeners) {
      kl.cancel();
    }
    keyListeners.clear();
  }

  void setMethodCallHandler(FMethod callback) {}

  invokeMethod(String method, [dynamic arguments]) async {
    return true;
  }

  Future<T?> invokeMethodWithResult<T>(String method,
      [dynamic arguments]) async {
    return null;
  }

  // just for compilation
  void syncAndroidServiceAppDirConfigPath() {}

  void setFullscreenCallback(void Function(bool) fun) {
    context["onFullscreenChanged"] = (bool v) {
      fun(v);
    };
  }
}

extension on JSObject {
  external JSArrayBuffer get buffer;
  external int get byteOffset;
  external int get byteLength;
}
