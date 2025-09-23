# Application-Programming-Interface (API)

**experimental**

The Pear API enables applications to interact with Pear platform features.

Most application peer-to-peer functionality is provided by ecosystem modules rather than the API.

Platform APIs are unchangeable. Compatibility cannot break. So the Pear API surface aims to be (and remain) as small as possible.

## `global.Pear`

The Pear Platform API is made available globally as `Pear`.

The `Pear` API is designed to be small and immutable.

Any future changes to the `Pear` API will be non-breaking additions.

## `Pear.config <Object>`

Contains application configuration data.

### `Pear.config.key <Object|null>`

The `config.key` object holds both Hexadecimal and Z-Base-32 encodings of the key, and is of the form `{ z32: <String>, hex: <String> }`,

### `Pear.config.dev <Boolean>`

Whether the application is in development mode.

### `Pear.config.tier <String>`

Runtime scenario (dev, staging or production)

### `Pear.config.storage <String>`

Application storage path

### `Pear.config.name <String>`

Application name

### `Pear.config.main <String>`

Application entry file

### `Pear.config.channel <String|null>`

Application release/staging channel.

### `Pear.config.options <Object>`

Configuration options. The `pear` configuration object as supplied via an applications `package.json` file.

**References**

* [Configuration](https://docs.pears.com/pear-runtime/configuration)

### `Pear.config.env <Object>`

The environment variables that an application was started with, as key-value pairs in an object.

### `Pear.config.cwd <String>`

The current working directory that an application was started from.

### `Pear.config.flags <Object>`

Parsed command-line flag values as supplied when an application was started.

### `Pear.config.tools <Boolean>`

Indicates whether or not Devtools is enabled.

### `Pear.config.watch <Boolean>`

Indicates whether or not Watch-Reload functionality is enabled.

### `Pear.config.storage <String>`

Application storage path.

### `Pear.config.args <Array>`

Command-line application arguments passed like `pear run --dev . --some arg`.

### `Pear.config.release <Number>`

The current release length as marked by the `pear release` command.

**References**

* [`pear release`](https://docs.pears.com/pear-runtime/cli)

### `Pear.config.link <String>`

Pear application link. Can be a `pear://` link or a local directory.

Can include a fragment link eg. `pear://link#fragment`.

**References**

* [Pear.config.linkData](#pearconfiglinkdata-string)
* [`pear run`](https://docs.pears.com/pear-runtime/cli)

### `Pear.config.links <Object|Array>`

Holds trusted Pear application links and domains as specified in the `links` field inside `package.json`.

**References**

* [pear.links](https://docs.pears.com/configuration#pearlinks-objectarray)
* [`pear run`](https://docs.pears.com/pear-runtime/cli)

### `Pear.config.linkData <String>`

Holds just the data portion of a Pear link.

The Pear link of an application. Takes the form `pear://<key>/<data>`.

In development, `pear://dev/<data>`.

**References**

* [Pear.config.link](#pearconfiglink-string)
* [`pear run`](https://docs.pears.com/pear-runtime/cli)

### `Pear.config.checkpoint <Any>`

Holds state as set by `Pear.checkpoint()`. When an application restarts it will hold the most recent value passed to `Pear.checkpoint()`.

Stores state that will be available as `Pear.config.checkpoint` next time the application starts.

The `Pear.config.checkpoint` property immediately reflects the latest checkpoint.

The returned `Promise` will resolve once the checkpoint has been successfully stored.

**References**

* [Pear.checkpoint()](#pear-checkpoint-any)

### `Pear.config.release <Integer>`

Application release sequence integer.

### `Pear.config.flags <Object>`

Parsed runtime flags. For internal/advanced use.

### `Pear.config.applink <String>`

Pear application link. May be a `pear://` link or a local directory. Can also include entrypoint and fragment eg. `pear://link#fragment`.

### `Pear.config.dependencies <Object>`

Application dependencies.

### `Pear.config.dir <String>`

Root directory of project.

### `Pear.config.pearDir <String>`

Directory for Pear runtime.

### `Pear.config.dht.nodes <Array<Object>>`

A list of known [DHT](https://docs.pears.com/building-blocks/hyperdht) nodes of the form `{ host: <String>, port: <Number> }`. The nodes are set when the Pear application is started.

Unless started with a custom set of bootstrap nodes, Pear caches known nodes to speed up connecting to the swarm and to make it more resilient.

### `Pear.config.dht.bootstrap <Array<Object>>`

A list of custom bootstrap nodes Pear is started with of the form `{ host: <String>, port: <Number> }`.

## `Pear.checkpoint(<Any>) => Promise`

Stores state that will be available as `Pear.config.checkpoint` next time the application starts.

The `Pear.config.checkpoint` property immediately reflects the latest checkpoint.

The returned `Promise` will resolve once the checkpoint has been successfully stored.

**References**

* [Pear.config.checkpoint()](#pear--config-checkpoint-any)

## Pear.messages(\[ pattern ], \[ listener ]) -> Iterable

A function which accepts a pattern object and returns an [`Iambus`](https://github.com/holepunchto/iambus) subscriber (which inherits from [`streamx`](https://github.com/mafintosh/streamx) `Readable`) which emits message objects matching a provided pattern object.

If no pattern object or an empty pattern object is provided all messages will be emitted. A pattern object is an object (typically) containing a subset of matching values for a given target object. Message objects can be user generated or platform generated.

The subscriber stream has a `data` event which can be listened to, it can also be consumed with `for await` and an listener function can be passed in addition to pattern (`message(pattern, listener)`) or as a single argument (`messages(listener)`) (indicating a catch-all pattern).

A message object may have any properties. Platform-generated messages are given a `type` property.

### Examples:

Listen for an internal platform message using a pattern object and listener function:

```js
const { messages } = Pear

messages({ type: 'pear/wakeup' }, ({ data, link }) => {
  console.log('pear/wakeup', data, link)
})
```

Tiny utility module which logs all messages using `for await`:

```js
const { messages } = Pear

for await (const message of messages()) {
  if (global.LOGBUS) console.log('BUS:', message)
}
```

Use `message` to create an application message:

```js
const { message, messages } = Pear

const ctaClicks = messages({ type: 'my-app/user-cta' })

ctaClicks.on('data', (msg) => { console.log('cta click', msg) })

// elsewhere
onUserClickCta((event, data) => {
  message({ type: 'my-app/user-cta', event, data })
})
```

## `await Pear.message(<Object>)`

Send a message which will be:

```js
const { message, messages } = Pear

async function logMessages () {
  for await (const message of messages()) console.log(message)
}

logMessages().catch(console.error)

let count = 0
do {
  await message({ type: 'tick', count })
  await new Promise((resolve) => setTimeout(resolve, 1000))
} while (count++ < 1000)
```

## `Pear.worker <Object>`

Pear Worker is used to spawn processes and facilitate communication between the parent and child processes in the Pear Runtime.

The spawned worker process inherits standard input, output, and error from the parent process.

A bidirectional pipe is also created which enables communication between the parent and worker process.

Reference counting is handled automatically to manage the sidecar lifecycle.

### `const pipe = Pear.worker.run(link <String>, args <Array<String>>)`

Runs a Pear Worker by spawning a Pear Terminal Application process from the specified `link` parameter. The Worker uses the flags of the parent application but any application arguments must be passed using the `args` parameter, the `args` parameter also sets `Pear.config.args`. Returns a pipe (a [`streamx`](https://github.com/mafintosh/streamx) `Duplex` stream) for Worker communication.

### `const pipe = Pear.worker.pipe()`

Returns the pipe (a [`streamx`](https://github.com/mafintosh/streamx) `Duplex` stream) created to the worker process.

## `Pear.media <Object>`

Media interface

### `const status = await Pear.media.status.microphone()`

Resolves to: `<String>`

If access to the microphone is available, resolved value will be `'granted'`.

Any other string indicates lack of permission. Possible values are `'granted'`, `'not-determined'`, `'denied'`, `'restricted'`, `'unknown'`.

### `const status = await Pear.media.status.camera()`

Resolves to: `<String>`

If access to the camera is available, resolved value will be `'granted'`.

Any other string indicates lack of permission. Possible values are `'granted'`, `'not-determined'`, `'denied'`, `'restricted'`, `'unknown'`.

### `const status = await Pear.media.status.screen()`

Resolves to: `<String>`

If access to the screen is available, resolved value will be `'granted'`.

Any other string indicates lack of permission. Possible values are `'granted'`, `'not-determined'`, `'denied'`, `'restricted'`, `'unknown'`.

### `const success = await Pear.media.access.microphone()`

Resolves to: `<Boolean>`

Request access to the microphone. Resolves to `true` if permission is granted.

### `const success = await Pear.media.access.camera()`

Resolves to: `<Boolean>`

Request access to the camera. Resolves to `true` if permission is granted.

### `const success = await Pear.media.access.screen()`

Resolves to: `<Boolean>`

Request access to screen sharing. Resolves to `true` if permission is granted.

### `const sources = await Pear.media.desktopSources(options <Object>)`

Captures available desktop sources. Resolves to an array of objects with shape `{ id <String>, name <String>, thumbnail <NativeImage>, display_id <String>, appIcon <NativeImage> }`. The `id` is the window or screen identifier. The `name` is the window title or `'Screen <index>'` in multiscreen scenarios or else `Entire Screen`. The `display_id` identifies the screen. The thumbnail is a scaled down screen capture of the window/screen.

**Options**

* `types <Array<String>>` - Default: `['screen', 'window']`. Filter by types. Types are `'screen'` and `'window'`.
* `thumbnailSize <Object>` - Default: `{width: 150, height: 150}`. Set thumbnail scaling (pixels)
* `fetchWindowIcons <Boolean>` - Default: `false`. Populate `appIcon` with Window icons, or else `null`.

**References**

* <https://www.electronjs.org/docs/latest/api/desktop-capturer#desktopcapturergetsourcesoptions>
* <https://www.electronjs.org/docs/latest/api/structures/desktop-capturer-source>
* [`<NativeImage>`](https://www.electronjs.org/docs/latest/api/native-image)

### `const path = Pear.media.getPathForFile(file <File>)`

Accepts a web [`File`](https://developer.mozilla.org/en-US/docs/Web/API/File/File) object and returns the file system path for that file as a `String`. In cases where the `file` argument is not a `File` object an exception is thrown. In the case that the `file` is constructed in JS and is not backed by a file on disk an empty string is returned.

Available in Desktop Applications only.

**References**

* <https://www.electronjs.org/docs/latest/api/web-utils#webutilsgetpathforfilefile>

### `Pear.versions <Async Function>`

Function that returns a promise which resolves to a Pear versions object with the shape `{ fork <Integer>, length <Integer>, key <Buffer> }`.

The `key` is a Buffer of the run key. The `length` is the size of the relevant Hypercore. The `fork` property is determined by data truncation.

These three properties together are a unique identifier for the entire state of both applications and the Pear platform.

### `Pear.versions.platform { fork <Integer>, length <Integer>, key <Buffer> }`

The platform version.

### `Pear.versions.app { fork <Integer>, length <Integer>, key <Buffer> }`

The application version.

### `Pear.versions.runtimes { bare <Integer>, electron <Integer>, pear <Integer> }`

The versions of runtimes.

**References**

* [Pear.config.key](#pearconfigkey-objectnull)

### `Pear.teardown(fn <Async Function|Function>)`

Register application clean-up handlers to be called when an application begins to unload.

May be called multiple times to register multiple teardown handlers.

Functions supplied to teardown will be executed in order of registration when an application begins to unload. Any promise returned from each supplied function will be waited upon until resolution before calling the next teardown handler.

### Pear.reload()

Refresh application in Desktop applications. Not available in terminal applications.

### `Pear.restart()`

Restart the application. Desktop Applications only.

### `Pear.exit(code)`

Exits the process with the provided exit code.

### `Pear.updates(listener <Async Function|Function>) => streamx.Readable`

The `listener` function is called for every incoming update with an `update` object of the form:

```js
{
  type: 'pear/updates',
  version: { fork <Integer>, length <Integer>, key <String(hex)>,  } | null,
  app <Boolean>,
  diff <Array <String> >,
}
```

* `version` is a Pear version object holding incoming version information
* `app` indicates whether the update represents an application (`true`) or platform (`false`) update
* `diff` requires `--update-diffs` flag (else `null`). An array of objects of form `{ type, key}`.
  * `type` `<String>` - Operation type `update` or `delete`
  * `key` `<String>` - Drive key for a given updated file e.g. `/path/to/file.txt`

Also returns a [`streamx`](https://github.com/mafintosh/streamx) `Readable`) stream.

### `const update = await Pear.updated()`

Returns the current `update` object of the form:

```js
{
  version: { fork <Integer>, length <Integer>, key <String(hex)>,  } | null,
  app <Boolean>,
  diff <Array <String>>,
} | undefined
```

* `version` is a Pear version object holding incoming version information
* `app` indicates whether the update represents an application (`true`) or platform (`false`) update
* `diff` requires `--update-diffs` flag (else `null`). An array of objects of form `{ type, key}`.
  * `type` `<String>` - Operation type `update` or `delete`
  * `key` `<String>` - Drive key for a given updated file e.g. `/path/to/file.txt`

Returns `undefined` if the app hasn't updated since the application started.

### `Pear.wakeups(listener <Async Function|Function>) => streamx.Readable`

A wakeup occurs in the following cases:

* when a trusted `pear://` link is clicked and the application for that link is already open
* when used with `pear run --detached pear://<key>[/data]`

The `listener` function is called for every incoming wakeup with a `wakeup` object of the form:

```js
{
  type: 'pear/wakeup',
  link: <String>,
  linkData: <String>,
  fragment: <String>,
  entrypoint: <String>
}
```

* `link` is the `pear://` link for the application receiving the wakeup
* `linkData` is everything after the key in the `pear://` link - this would be `pathname` of a [`URL`](https://developer.mozilla.org/en-US/docs/Web/API/URL/URL) object but without the leading slash (`/`). Given `pear://8ts9yz9dtucxzwbxafygnjasqe9ti3dt3w7rm6sbiu8prmidacao/some/more/stuff` the `data` string would hold `some/more/stuff`.
* `fragment` is the `fragment` part of `pear://link#fragment` (location hash without the `#` prefix).
* `entrypoint` includes `entrypoint` of `pear://link/some/entry/point` (URL pathname).

Also returns a [`streamx`](https://github.com/mafintosh/streamx) `Readable`) stream.

### `Pear.badge(count <Integer|null>) => Promise<Boolean>`

Set the badge number for the application on desktop for Linux & MacOS. Setting the `count` to `0` will hide the badge while `null` will display a plain dot on MacOS only.

Returns a `Boolean` promise for whether the call succeeded.

Desktop Applications only.

### `Pear.tray(options <Object>, listener <Async Function|Function>) => Promise<untray()>`

Configure a tray icon for the application. This method will return a promise which resolves to an `untray()` function for removing the tray.

The `listener` function is triggered whenever a menu item or the tray icon is clicked. It receives a single argument `key` that represents the menu item `key` that was clicked or the special value of `'click'` for when the menu icon itself was clicked. If no `listener` function is provided, a default listener will show the application window when triggered with `'click'` or `'show'` and quits with `'quit'`.

A Pear application must be `hideable` to support adding a tray (see [`pear.gui.hideable`](https://docs.pears.com/configuration#pear.gui.hideable-less-than-boolean-greater-than-default-false)).

WARNING: Linux tray support varies which can cause scenarios where the application's tray doesn't work and closing the app will be hidden and inaccessible. Using a tray and `hideable` on Linux is not recommended.

Desktop Applications only.

**Options**

* `icon <String>` Default: The Pear icon - The path for icon for the tray relative to the project root. Supported formats: PNG & JPEG
* `menu <Object>` Default: ``{ show: `Show ${Pear.config.name}`, quit: 'Quit' }`` - The tray menu items. Each property of the object is the `key` passed to the `listener` and whose value is the text displayed in the menu.
* `os <Object>` Default: `{ win32: true, linux: true, darwin: true }` - which platforms support using the tray menu. The platform is checked via the `process.platform` value.

### `const win = new Pear.Window(entry <String>, options <Object>)`

Desktop Applications only.

Create a new `Window` instance.

**Options**

* `show <Boolean>` Default: `true` - show the window as soon as it has been opened
* `x <Integer>` - the horizontal position of left side of the window (pixels)
* `y <Integer>` - vertical window position (pixels)
* `width <Integer>` - the width of the window (pixels)
* `height <Integer>` - the height of the window (pixels)
* `center <Boolean` - center the window upon opening
* `minWidth <Integer>` - window minimum width (pixels)
* `minHeight <Integer>` - window minimum height (pixels)
* `maxWidth <Integer>` - window maximum width (pixels)
* `maxHeight <Integer>` - window maximum height (pixels)
* `resizable <Boolean>` - window resizability
* `movable <Boolean>` - window movability
* `minimizable <Boolean>` - window minimizability
* `maximizable <Boolean>` - window maximizability
* `closable <Boolean>` - window closability
* `focusable <Boolean>` - window focusability
* `alwaysOnTop <Boolean>` - Set window to always be on top
* `fullscreen <Boolean>` - Set window to fullscreen upon open
* `kiosk <Boolean>` - Set window to enter kiosk mode upon open
* `autoHideMenuBar <Boolean>` - Hide menu bar unless Alt key is pressed (Linux, Windows)
* `hasShadow <Boolean>` - Set window shadow
* `opacity <Number>` - Set window opacity (0.0 - 1.0) (Windows, macOS)
* `transparent <Boolean>` - Set window transparency
* `backgroundColor <String>` Default: `'#FFF'` - window default background color. Hex, RGB, RGBA, HSL HSLA, CSS color

### `win.on[ce]('message', (...args) => { })`

### `for await (const [ ...args ] of win)`

Receive a message from the window. The received `args` array is deserialized via `JSON.parse`.

**References**

* [`win.send()`](#await-winsendargs)

### `const success = await win.open(options <Object>)`

Resolves to: `<Boolean>`

Open the window.

**Options**

* `show` Default: `true` - show the window as soon as it has been opened
* `x <Integer>` - the horizontal position of left side of the window (pixels)
* `y <Integer>` - vertical window position (pixels)
* `width <Integer>` - the width of the window (pixels)
* `height <Integer>` - the height of the window (pixels)
* `center <Boolean` - center the window upon opening
* `minWidth <Integer>` - window minimum width (pixels)
* `minHeight <Integer>` - window minimum height (pixels)
* `maxWidth <Integer>` - window maximum width (pixels)
* `maxHeight <Integer>` - window maximum height (pixels)
* `resizable <Boolean>` - window resizability
* `movable <Boolean>` - window movability
* `minimizable <Boolean>` - window minimizability
* `maximizable <Boolean>` - window maximizability
* `closable <Boolean>` - window closability
* `focusable <Boolean>` - window focusability
* `alwaysOnTop <Boolean>` - Set window to always be on top
* `fullscreen <Boolean>` - Set window to fullscreen upon open
* `kiosk <Boolean>` - Set window to enter kiosk mode upon open
* `autoHideMenuBar <Boolean>` - Hide menu bar unless Alt key is pressed (Linux, Windows)
* `hasShadow <Boolean>` - Set window shadow
* `opacity <Number>` - Set window opacity (0.0 - 1.0) (Windows, macOS)
* `transparent <Boolean>` - Set window transparency
* `backgroundColor <String>` Default: `'#FFF'` - window default background color. Hex, RGB, RGBA, HSL HSLA, CSS color

### `const success = await win.close()`

Resolves to: `<Boolean>`

Close the window.

### `const success = await win.show()`

Resolves to: `<Boolean>`

Show the window.

### `const success = await win.hide()`

Resolves to: `<Boolean>`

Hide the window.

### `const success = await win.focus()`

Resolves to: `<Boolean>`

Focus the window.

### `const success = await win.blur()`

Resolves to: `<Boolean>`

Blur the window.

### `const success = await win.minimize()`

Resolves to: `<Boolean>`

Minimize the window.

### `const success = await win.maximize()`

Resolves to: `<Boolean>`

Maximize the window.

### `const success = await win.restore()`

Resolves to: `<Boolean>`

Unmaximize/unminimize the window if it is currently maximized/minimized.

### `await win.send(...args)`

Send arguments to the window. They will be serialized with `JSON.stringify`.

### `const dimensions = await win.dimensions()`

Resolves to: `{x <Integer>, y <Integer>, width <Integer>, height <Integer>} | null`.

The height, width, horizontal (`x`), vertical (`y`) position of the window relative to the screen.

All units are (pixels)

If the window is closed this will resolve to `null`.

**References**

* [await win.dimensions(options)](#await-windimensionsoptions-object)

### `await win.dimensions(options <Object>)`

```js
const win = new Pear.Window('./some.html', {
  x: 10,
  y: 450,
  width: 300,
  height: 350
})

await win.open()
await new Promise((resolve) => setTimeout(resolve, 1000))

await win.dimensions({
  x: 20,
  y: 50,
  width: 550,
  height: 300,
})

```

Sets the dimensions of the window.

**Options**

* `x <Integer>` - the horizontal position of left side of the window (pixels)
* `y <Integer>` - the vertical position of the top of the window (pixels)
* `width <Integer>` - the width of the window (pixels)
* `height <Integer>` - the height of the window (pixels)
* `position <String>` - may be `'center'` to set the window in the center of the screen or else `undefined`.

**References**

* [const dimensions = await win.dimensions()](#const-dimensions-await-windimensions)

### `const visible = await win.isVisible()`

Resolves to: `<Boolean>`

Whether the window is visible.

### `const minimized = await win.isMinimized()`

Resolves to: `<Boolean>`

Whether the window is minimized.

### `const maximized = await win.isMaximized()`

Resolves to: `<Boolean>`

Whether the window is maximized.

### `const closed = await win.isClosed()`

Resolves to: `<Boolean>`

Whether the window is closed.

### `const view = new Pear.View(options <Object>)`

Desktop Applications only.

Create a new `View` instance. Views provide isolated content views. Frameless, chromeless windows that can be embedded inside other windows and views.

**Options**

* `x <Integer>` - the horizontal position of left side of the view (pixels)
* `y <Integer>` - vertical view position (pixels)
* `width <Integer>` - the width of the view (pixels)
* `height <Integer>` - the height of the view (pixels)
* `backgroundColor <String>` Default: `'#FFF'` - view default background color. Hex, RGB, RGBA, HSL HSLA, CSS color
* `autoresize <Object>` Default `{ width=true, height=true, vertical=false, horizontal=false }` - dimensions for the view to autoresize alongside. For example, if `width` is `true` and the view container increases/decreases in width, the view will increase/decrease in width at the same rate.

**References**

* <https://www.electronjs.org/docs/latest/api/browser-view#viewsetautoresizeoptions-experimental>
* <https://www.electronjs.org/docs/latest/api/browser-view#viewsetbackgroundcolorcolor-experimental>

### `view.on[ce]('message', (...args) => { })`

### `for await (const [ ...args ] of view)`

Receive a message from the view. The received `args` array is deserialized via `JSON.parse`.

**References**

* [`view.send()`](#await-viewsendargs)

### `const success = await view.open(options <Object>)`

Resolves to: `<Boolean>`

Open the view.

**Options**

* `x <Integer>` - the horizontal position of left side of the view (pixels)
* `y <Integer>` - vertical view position (pixels)
* `width <Integer>` - the width of the view (pixels)
* `height <Integer>` - the height of the view (pixels)
* `backgroundColor <String>` Default: `'#FFF'` - view default background color. Hex, RGB, RGBA, HSL HSLA, CSS color
* `autoresize <Object>` Default `{ width=true, height=true, vertical=false, horizontal=false }` - dimensions for the view to autoresize alongside. For example, if `width` is `true` and the view container increases/decreases in width, the view will increase/decrease in width at the same rate.

### `const success = await view.close()`

Resolves to: `<Boolean>`

Close the view.

### `const success = await view.show()`

Resolves to: `<Boolean>`

Show the view.

### `const success = await view.hide()`

Resolves to: `<Boolean>`

Hide the view.

### `const success = await view.focus()`

Resolves to: `<Boolean>`

Focus the view.

### `const success = await view.blur()`

Resolves to: `<Boolean>`

Blur the view.

### `await view.send(...args)`

Send arguments to the view. They will be serialized with `JSON.stringify`.

### `const dimensions = await view.dimensions()`

Resolves to: `{x <Integer>, y <Integer>, width <Integer>, height <Integer>} | null`.

The height, width, horizontal (`x`), vertical (`y`) position of the window relative to the screen.

All units are (pixels)

If the Window is closed this will resolve to `null`.

**References**

* [await view.dimensions(options)](#await-viewdimensionsoptions-object)

### `await view.dimensions(options <Object>)`

```js
const view = new Pear.View('./some.html', {
  x: 10,
  y: 450,
  width: 300,
  height: 350
})

await view.open()
await new Promise((resolve) => setTimeout(resolve, 1000))

await view.dimensions({
  x: 20,
  y: 50,
  width: 550,
  height: 300
})
```

Sets the dimensions of the view.

**Options**

* `x <Integer>` - the horizontal position of left side of the window (pixels)
* `y <Integer>` - the vertical position of the top of the window (pixels)
* `width <Integer>` - the width of the window (pixels)
* `height <Integer>` - the height of the window (pixels)

**References**

* [const dimensions = await view.dimensions()](#const-dimensions--await-viewdimensions)

### `const visible = await view.isVisible()`

Resolves to: `<Boolean>`

Whether the view is visible.

### `const closed = await view.isClosed()`

Resolves to: `<Boolean>`

Whether the view is closed.

### `const { self } = Pear.Window` `const { self } = Pear.View`

### `const success = await self.focus()`

Resolves to: `<Boolean>`

Focus current view or window.

### `const success = await self.blur()`

Resolves to: `<Boolean>`

Blur current view or window.

### `const success = await self.show()`

Resolves to: `<Boolean>`

Show current view or window.

### `const success = await self.hide()`

Resolves to: `<Boolean>`

Hide current view or window.

### `const success = await self.minimize()`

Resolves to: `<Boolean>`

Minimize current window.

Throws a `TypeError` if `self` is a view.

### `const success = await self.maximize()`

Resolves to: `<Boolean>`

Maximize current window.

Throws a `TypeError` if `self` is a view.

### `const success = await self.restore()`

Resolves to: `<Boolean>`

Unmaximize/unminimize the current window if it is currently maximized/minimized.

Throws a `TypeError` if `self` is a view.

### `const success = await self.close()`

Resolves to: `<Boolean>`

Closes the current view or window.

### `const isVisible = await self.isVisible()`

Resolves to: `<Boolean>`

Whether the current window or view is visible.

### `const isMaximized = await self.isMaximized()`

Resolves to: `<Boolean>`

Whether the current window is maximized. Throws a `TypeError` if `self` is a view.

### `const isMinimized = await self.isMinimized()`

Resolves to: `<Boolean>`

Whether the current window is minimized. Throws a `TypeError` if `self` is a view.

### `const { parent } = Pear.Window` `const { parent } = Pear.View`

### `parent.on[ce]('message', (...args) => { })`

### `for await (const [ ...args ] of parent)`

Receive a message from the parent window or view. The received `args` array is deserialized via `JSON.parse`.

### `await parent.send(...args)`

Send arguments to the parent view or window. They will be serialized with `JSON.stringify`.

### `const success = await parent.focus()`

Resolves to: `<Boolean>`

Focus parent view or window.

### `const success = await parent.blur()`

Resolves to: `<Boolean>`

Blur parent view or window.

### `const success = await parent.show()`

Resolves to: `<Boolean>`

Show parent view or window.

### `const success = await parent.hide()`

Resolves to: `<Boolean>`

Hide parent view or window.

### `const success = await parent.minimize()`

Resolves to: `<Boolean>`

Minimize parent window.

Throws a `TypeError` if `parent` is a view.

### `const success = await parent.maximize()`

Resolves to: `<Boolean>`

Maximize parent window.

Throws a `TypeError` if `parent` is a view.

### `const success = await parent.restore()`

Resolves to: `<Boolean>`

Unmaximize/unminimize the parent window if it is currently maximized/minimized.

Throws a `TypeError` if `parent` is a view.

### `const success = await parent.close()`

Resolves to: `<Boolean>`

Closes the parent view or window.

### `const isVisible = await parent.isVisible()`

Resolves to: `<Boolean>`

Whether the parent window or view is visible.

### `const isMaximized = await parent.isMaximized()`

Resolves to: `<Boolean>`

Whether the parent window is maximized. Throws a `TypeError` if `parent` is a view.

### `const isMinimized = await parent.isMinimized()`

Resolves to: `<Boolean>`

Whether the parent window is minimized. Throws a `TypeError` if `parent` is a view.

## Web APIs

Most [Web APIs](https://developer.mozilla.org/en-US/docs/Web/API) will work as-is.

This section details deviations in behavior from and notable aspects of Web APIs as they relate to Pear.

### `window.open`

The [`window.open`](https://developer.mozilla.org/en-US/docs/Web/API/Window/open) Web API function will ignore all arguments except for the URL parameter.

In browsers, `window.open` opens a new browser window. The opened window belongs to the same browser from which `window.open` is called.

In Pear, `window.open` loads the URL in the **default system browser**. It does *not* create a new application window (use `Pear.Window` to create application windows).

Therefore Pear's `window.open` only supports a single URL argument. The `target` and `windowFeatures` parameters that browsers support are discarded.

### Scripts and Modules

Like browsers, there is no support for CommonJS (e.g. the `require` function as used by Node.js is not supported in Pear Applications).

Like browsers, there is support for native EcmaScript Modules (ESM). A JavaScript Script has no module capabilities. A JavaScript Module has ESM capabilities.

Use `<script type="module" src="path/to/my-file.js">` to load a JavaScript Module.

Use `<script src="path/to/my-file.js">` to load a JavaScript Script.


# Application-Programming-Interface (API)

**experimental**

The Pear API enables applications to interact with Pear platform features.

Most application peer-to-peer functionality is provided by ecosystem modules rather than the API.

Platform APIs are unchangeable. Compatibility cannot break. So the Pear API surface aims to be (and remain) as small as possible.

## `global.Pear`

The Pear Platform API is made available globally as `Pear`.

The `Pear` API is designed to be small and immutable.

Any future changes to the `Pear` API will be non-breaking additions.

## `Pear.config <Object>`

Contains application configuration data.

### `Pear.config.key <Object|null>`

The `config.key` object holds both Hexadecimal and Z-Base-32 encodings of the key, and is of the form `{ z32: <String>, hex: <String> }`,

### `Pear.config.dev <Boolean>`

Whether the application is in development mode.

### `Pear.config.tier <String>`

Runtime scenario (dev, staging or production)

### `Pear.config.storage <String>`

Application storage path

### `Pear.config.name <String>`

Application name

### `Pear.config.main <String>`

Application entry file

### `Pear.config.channel <String|null>`

Application release/staging channel.

### `Pear.config.options <Object>`

Configuration options. The `pear` configuration object as supplied via an applications `package.json` file.

**References**

* [Configuration](https://docs.pears.com/pear-runtime/configuration)

### `Pear.config.env <Object>`

The environment variables that an application was started with, as key-value pairs in an object.

### `Pear.config.cwd <String>`

The current working directory that an application was started from.

### `Pear.config.flags <Object>`

Parsed command-line flag values as supplied when an application was started.

### `Pear.config.tools <Boolean>`

Indicates whether or not Devtools is enabled.

### `Pear.config.watch <Boolean>`

Indicates whether or not Watch-Reload functionality is enabled.

### `Pear.config.storage <String>`

Application storage path.

### `Pear.config.args <Array>`

Command-line application arguments passed like `pear run --dev . --some arg`.

### `Pear.config.release <Number>`

The current release length as marked by the `pear release` command.

**References**

* [`pear release`](https://docs.pears.com/pear-runtime/cli)

### `Pear.config.link <String>`

Pear application link. Can be a `pear://` link or a local directory.

Can include a fragment link eg. `pear://link#fragment`.

**References**

* [Pear.config.linkData](#pearconfiglinkdata-string)
* [`pear run`](https://docs.pears.com/pear-runtime/cli)

### `Pear.config.links <Object|Array>`

Holds trusted Pear application links and domains as specified in the `links` field inside `package.json`.

**References**

* [pear.links](https://docs.pears.com/configuration#pearlinks-objectarray)
* [`pear run`](https://docs.pears.com/pear-runtime/cli)

### `Pear.config.linkData <String>`

Holds just the data portion of a Pear link.

The Pear link of an application. Takes the form `pear://<key>/<data>`.

In development, `pear://dev/<data>`.

**References**

* [Pear.config.link](#pearconfiglink-string)
* [`pear run`](https://docs.pears.com/pear-runtime/cli)

### `Pear.config.checkpoint <Any>`

Holds state as set by `Pear.checkpoint()`. When an application restarts it will hold the most recent value passed to `Pear.checkpoint()`.

Stores state that will be available as `Pear.config.checkpoint` next time the application starts.

The `Pear.config.checkpoint` property immediately reflects the latest checkpoint.

The returned `Promise` will resolve once the checkpoint has been successfully stored.

**References**

* [Pear.checkpoint()](#pear-checkpoint-any)

### `Pear.config.release <Integer>`

Application release sequence integer.

### `Pear.config.flags <Object>`

Parsed runtime flags. For internal/advanced use.

### `Pear.config.applink <String>`

Pear application link. May be a `pear://` link or a local directory. Can also include entrypoint and fragment eg. `pear://link#fragment`.

### `Pear.config.dependencies <Object>`

Application dependencies.

### `Pear.config.dir <String>`

Root directory of project.

### `Pear.config.pearDir <String>`

Directory for Pear runtime.

### `Pear.config.dht.nodes <Array<Object>>`

A list of known [DHT](https://docs.pears.com/building-blocks/hyperdht) nodes of the form `{ host: <String>, port: <Number> }`. The nodes are set when the Pear application is started.

Unless started with a custom set of bootstrap nodes, Pear caches known nodes to speed up connecting to the swarm and to make it more resilient.

### `Pear.config.dht.bootstrap <Array<Object>>`

A list of custom bootstrap nodes Pear is started with of the form `{ host: <String>, port: <Number> }`.

## `Pear.checkpoint(<Any>) => Promise`

Stores state that will be available as `Pear.config.checkpoint` next time the application starts.

The `Pear.config.checkpoint` property immediately reflects the latest checkpoint.

The returned `Promise` will resolve once the checkpoint has been successfully stored.

**References**

* [Pear.config.checkpoint()](#pear--config-checkpoint-any)

## Pear.messages(\[ pattern ], \[ listener ]) -> Iterable

A function which accepts a pattern object and returns an [`Iambus`](https://github.com/holepunchto/iambus) subscriber (which inherits from [`streamx`](https://github.com/mafintosh/streamx) `Readable`) which emits message objects matching a provided pattern object.

If no pattern object or an empty pattern object is provided all messages will be emitted. A pattern object is an object (typically) containing a subset of matching values for a given target object. Message objects can be user generated or platform generated.

The subscriber stream has a `data` event which can be listened to, it can also be consumed with `for await` and an listener function can be passed in addition to pattern (`message(pattern, listener)`) or as a single argument (`messages(listener)`) (indicating a catch-all pattern).

A message object may have any properties. Platform-generated messages are given a `type` property.

### Examples:

Listen for an internal platform message using a pattern object and listener function:

```js
const { messages } = Pear

messages({ type: 'pear/wakeup' }, ({ data, link }) => {
  console.log('pear/wakeup', data, link)
})
```

Tiny utility module which logs all messages using `for await`:

```js
const { messages } = Pear

for await (const message of messages()) {
  if (global.LOGBUS) console.log('BUS:', message)
}
```

Use `message` to create an application message:

```js
const { message, messages } = Pear

const ctaClicks = messages({ type: 'my-app/user-cta' })

ctaClicks.on('data', (msg) => { console.log('cta click', msg) })

// elsewhere
onUserClickCta((event, data) => {
  message({ type: 'my-app/user-cta', event, data })
})
```

## `await Pear.message(<Object>)`

Send a message which will be:

```js
const { message, messages } = Pear

async function logMessages () {
  for await (const message of messages()) console.log(message)
}

logMessages().catch(console.error)

let count = 0
do {
  await message({ type: 'tick', count })
  await new Promise((resolve) => setTimeout(resolve, 1000))
} while (count++ < 1000)
```

## `Pear.worker <Object>`

Pear Worker is used to spawn processes and facilitate communication between the parent and child processes in the Pear Runtime.

The spawned worker process inherits standard input, output, and error from the parent process.

A bidirectional pipe is also created which enables communication between the parent and worker process.

Reference counting is handled automatically to manage the sidecar lifecycle.

### `const pipe = Pear.worker.run(link <String>, args <Array<String>>)`

Runs a Pear Worker by spawning a Pear Terminal Application process from the specified `link` parameter. The Worker uses the flags of the parent application but any application arguments must be passed using the `args` parameter, the `args` parameter also sets `Pear.config.args`. Returns a pipe (a [`streamx`](https://github.com/mafintosh/streamx) `Duplex` stream) for Worker communication.

### `const pipe = Pear.worker.pipe()`

Returns the pipe (a [`streamx`](https://github.com/mafintosh/streamx) `Duplex` stream) created to the worker process.

## `Pear.media <Object>`

Media interface

### `const status = await Pear.media.status.microphone()`

Resolves to: `<String>`

If access to the microphone is available, resolved value will be `'granted'`.

Any other string indicates lack of permission. Possible values are `'granted'`, `'not-determined'`, `'denied'`, `'restricted'`, `'unknown'`.

### `const status = await Pear.media.status.camera()`

Resolves to: `<String>`

If access to the camera is available, resolved value will be `'granted'`.

Any other string indicates lack of permission. Possible values are `'granted'`, `'not-determined'`, `'denied'`, `'restricted'`, `'unknown'`.

### `const status = await Pear.media.status.screen()`

Resolves to: `<String>`

If access to the screen is available, resolved value will be `'granted'`.

Any other string indicates lack of permission. Possible values are `'granted'`, `'not-determined'`, `'denied'`, `'restricted'`, `'unknown'`.

### `const success = await Pear.media.access.microphone()`

Resolves to: `<Boolean>`

Request access to the microphone. Resolves to `true` if permission is granted.

### `const success = await Pear.media.access.camera()`

Resolves to: `<Boolean>`

Request access to the camera. Resolves to `true` if permission is granted.

### `const success = await Pear.media.access.screen()`

Resolves to: `<Boolean>`

Request access to screen sharing. Resolves to `true` if permission is granted.

### `const sources = await Pear.media.desktopSources(options <Object>)`

Captures available desktop sources. Resolves to an array of objects with shape `{ id <String>, name <String>, thumbnail <NativeImage>, display_id <String>, appIcon <NativeImage> }`. The `id` is the window or screen identifier. The `name` is the window title or `'Screen <index>'` in multiscreen scenarios or else `Entire Screen`. The `display_id` identifies the screen. The thumbnail is a scaled down screen capture of the window/screen.

**Options**

* `types <Array<String>>` - Default: `['screen', 'window']`. Filter by types. Types are `'screen'` and `'window'`.
* `thumbnailSize <Object>` - Default: `{width: 150, height: 150}`. Set thumbnail scaling (pixels)
* `fetchWindowIcons <Boolean>` - Default: `false`. Populate `appIcon` with Window icons, or else `null`.

**References**

* <https://www.electronjs.org/docs/latest/api/desktop-capturer#desktopcapturergetsourcesoptions>
* <https://www.electronjs.org/docs/latest/api/structures/desktop-capturer-source>
* [`<NativeImage>`](https://www.electronjs.org/docs/latest/api/native-image)

### `const path = Pear.media.getPathForFile(file <File>)`

Accepts a web [`File`](https://developer.mozilla.org/en-US/docs/Web/API/File/File) object and returns the file system path for that file as a `String`. In cases where the `file` argument is not a `File` object an exception is thrown. In the case that the `file` is constructed in JS and is not backed by a file on disk an empty string is returned.

Available in Desktop Applications only.

**References**

* <https://www.electronjs.org/docs/latest/api/web-utils#webutilsgetpathforfilefile>

### `Pear.versions <Async Function>`

Function that returns a promise which resolves to a Pear versions object with the shape `{ fork <Integer>, length <Integer>, key <Buffer> }`.

The `key` is a Buffer of the run key. The `length` is the size of the relevant Hypercore. The `fork` property is determined by data truncation.

These three properties together are a unique identifier for the entire state of both applications and the Pear platform.

### `Pear.versions.platform { fork <Integer>, length <Integer>, key <Buffer> }`

The platform version.

### `Pear.versions.app { fork <Integer>, length <Integer>, key <Buffer> }`

The application version.

### `Pear.versions.runtimes { bare <Integer>, electron <Integer>, pear <Integer> }`

The versions of runtimes.

**References**

* [Pear.config.key](#pearconfigkey-objectnull)

### `Pear.teardown(fn <Async Function|Function>)`

Register application clean-up handlers to be called when an application begins to unload.

May be called multiple times to register multiple teardown handlers.

Functions supplied to teardown will be executed in order of registration when an application begins to unload. Any promise returned from each supplied function will be waited upon until resolution before calling the next teardown handler.

### Pear.reload()

Refresh application in Desktop applications. Not available in terminal applications.

### `Pear.restart()`

Restart the application. Desktop Applications only.

### `Pear.exit(code)`

Exits the process with the provided exit code.

### `Pear.updates(listener <Async Function|Function>) => streamx.Readable`

The `listener` function is called for every incoming update with an `update` object of the form:

```js
{
  type: 'pear/updates',
  version: { fork <Integer>, length <Integer>, key <String(hex)>,  } | null,
  app <Boolean>,
  diff <Array <String> >,
}
```

* `version` is a Pear version object holding incoming version information
* `app` indicates whether the update represents an application (`true`) or platform (`false`) update
* `diff` requires `--update-diffs` flag (else `null`). An array of objects of form `{ type, key}`.
  * `type` `<String>` - Operation type `update` or `delete`
  * `key` `<String>` - Drive key for a given updated file e.g. `/path/to/file.txt`

Also returns a [`streamx`](https://github.com/mafintosh/streamx) `Readable`) stream.

### `const update = await Pear.updated()`

Returns the current `update` object of the form:

```js
{
  version: { fork <Integer>, length <Integer>, key <String(hex)>,  } | null,
  app <Boolean>,
  diff <Array <String>>,
} | undefined
```

* `version` is a Pear version object holding incoming version information
* `app` indicates whether the update represents an application (`true`) or platform (`false`) update
* `diff` requires `--update-diffs` flag (else `null`). An array of objects of form `{ type, key}`.
  * `type` `<String>` - Operation type `update` or `delete`
  * `key` `<String>` - Drive key for a given updated file e.g. `/path/to/file.txt`

Returns `undefined` if the app hasn't updated since the application started.

### `Pear.wakeups(listener <Async Function|Function>) => streamx.Readable`

A wakeup occurs in the following cases:

* when a trusted `pear://` link is clicked and the application for that link is already open
* when used with `pear run --detached pear://<key>[/data]`

The `listener` function is called for every incoming wakeup with a `wakeup` object of the form:

```js
{
  type: 'pear/wakeup',
  link: <String>,
  linkData: <String>,
  fragment: <String>,
  entrypoint: <String>
}
```

* `link` is the `pear://` link for the application receiving the wakeup
* `linkData` is everything after the key in the `pear://` link - this would be `pathname` of a [`URL`](https://developer.mozilla.org/en-US/docs/Web/API/URL/URL) object but without the leading slash (`/`). Given `pear://8ts9yz9dtucxzwbxafygnjasqe9ti3dt3w7rm6sbiu8prmidacao/some/more/stuff` the `data` string would hold `some/more/stuff`.
* `fragment` is the `fragment` part of `pear://link#fragment` (location hash without the `#` prefix).
* `entrypoint` includes `entrypoint` of `pear://link/some/entry/point` (URL pathname).

Also returns a [`streamx`](https://github.com/mafintosh/streamx) `Readable`) stream.

### `Pear.badge(count <Integer|null>) => Promise<Boolean>`

Set the badge number for the application on desktop for Linux & MacOS. Setting the `count` to `0` will hide the badge while `null` will display a plain dot on MacOS only.

Returns a `Boolean` promise for whether the call succeeded.

Desktop Applications only.

### `Pear.tray(options <Object>, listener <Async Function|Function>) => Promise<untray()>`

Configure a tray icon for the application. This method will return a promise which resolves to an `untray()` function for removing the tray.

The `listener` function is triggered whenever a menu item or the tray icon is clicked. It receives a single argument `key` that represents the menu item `key` that was clicked or the special value of `'click'` for when the menu icon itself was clicked. If no `listener` function is provided, a default listener will show the application window when triggered with `'click'` or `'show'` and quits with `'quit'`.

A Pear application must be `hideable` to support adding a tray (see [`pear.gui.hideable`](https://docs.pears.com/configuration#pear.gui.hideable-less-than-boolean-greater-than-default-false)).

WARNING: Linux tray support varies which can cause scenarios where the application's tray doesn't work and closing the app will be hidden and inaccessible. Using a tray and `hideable` on Linux is not recommended.

Desktop Applications only.

**Options**

* `icon <String>` Default: The Pear icon - The path for icon for the tray relative to the project root. Supported formats: PNG & JPEG
* `menu <Object>` Default: ``{ show: `Show ${Pear.config.name}`, quit: 'Quit' }`` - The tray menu items. Each property of the object is the `key` passed to the `listener` and whose value is the text displayed in the menu.
* `os <Object>` Default: `{ win32: true, linux: true, darwin: true }` - which platforms support using the tray menu. The platform is checked via the `process.platform` value.

### `const win = new Pear.Window(entry <String>, options <Object>)`

Desktop Applications only.

Create a new `Window` instance.

**Options**

* `show <Boolean>` Default: `true` - show the window as soon as it has been opened
* `x <Integer>` - the horizontal position of left side of the window (pixels)
* `y <Integer>` - vertical window position (pixels)
* `width <Integer>` - the width of the window (pixels)
* `height <Integer>` - the height of the window (pixels)
* `center <Boolean` - center the window upon opening
* `minWidth <Integer>` - window minimum width (pixels)
* `minHeight <Integer>` - window minimum height (pixels)
* `maxWidth <Integer>` - window maximum width (pixels)
* `maxHeight <Integer>` - window maximum height (pixels)
* `resizable <Boolean>` - window resizability
* `movable <Boolean>` - window movability
* `minimizable <Boolean>` - window minimizability
* `maximizable <Boolean>` - window maximizability
* `closable <Boolean>` - window closability
* `focusable <Boolean>` - window focusability
* `alwaysOnTop <Boolean>` - Set window to always be on top
* `fullscreen <Boolean>` - Set window to fullscreen upon open
* `kiosk <Boolean>` - Set window to enter kiosk mode upon open
* `autoHideMenuBar <Boolean>` - Hide menu bar unless Alt key is pressed (Linux, Windows)
* `hasShadow <Boolean>` - Set window shadow
* `opacity <Number>` - Set window opacity (0.0 - 1.0) (Windows, macOS)
* `transparent <Boolean>` - Set window transparency
* `backgroundColor <String>` Default: `'#FFF'` - window default background color. Hex, RGB, RGBA, HSL HSLA, CSS color

### `win.on[ce]('message', (...args) => { })`

### `for await (const [ ...args ] of win)`

Receive a message from the window. The received `args` array is deserialized via `JSON.parse`.

**References**

* [`win.send()`](#await-winsendargs)

### `const success = await win.open(options <Object>)`

Resolves to: `<Boolean>`

Open the window.

**Options**

* `show` Default: `true` - show the window as soon as it has been opened
* `x <Integer>` - the horizontal position of left side of the window (pixels)
* `y <Integer>` - vertical window position (pixels)
* `width <Integer>` - the width of the window (pixels)
* `height <Integer>` - the height of the window (pixels)
* `center <Boolean` - center the window upon opening
* `minWidth <Integer>` - window minimum width (pixels)
* `minHeight <Integer>` - window minimum height (pixels)
* `maxWidth <Integer>` - window maximum width (pixels)
* `maxHeight <Integer>` - window maximum height (pixels)
* `resizable <Boolean>` - window resizability
* `movable <Boolean>` - window movability
* `minimizable <Boolean>` - window minimizability
* `maximizable <Boolean>` - window maximizability
* `closable <Boolean>` - window closability
* `focusable <Boolean>` - window focusability
* `alwaysOnTop <Boolean>` - Set window to always be on top
* `fullscreen <Boolean>` - Set window to fullscreen upon open
* `kiosk <Boolean>` - Set window to enter kiosk mode upon open
* `autoHideMenuBar <Boolean>` - Hide menu bar unless Alt key is pressed (Linux, Windows)
* `hasShadow <Boolean>` - Set window shadow
* `opacity <Number>` - Set window opacity (0.0 - 1.0) (Windows, macOS)
* `transparent <Boolean>` - Set window transparency
* `backgroundColor <String>` Default: `'#FFF'` - window default background color. Hex, RGB, RGBA, HSL HSLA, CSS color

### `const success = await win.close()`

Resolves to: `<Boolean>`

Close the window.

### `const success = await win.show()`

Resolves to: `<Boolean>`

Show the window.

### `const success = await win.hide()`

Resolves to: `<Boolean>`

Hide the window.

### `const success = await win.focus()`

Resolves to: `<Boolean>`

Focus the window.

### `const success = await win.blur()`

Resolves to: `<Boolean>`

Blur the window.

### `const success = await win.minimize()`

Resolves to: `<Boolean>`

Minimize the window.

### `const success = await win.maximize()`

Resolves to: `<Boolean>`

Maximize the window.

### `const success = await win.restore()`

Resolves to: `<Boolean>`

Unmaximize/unminimize the window if it is currently maximized/minimized.

### `await win.send(...args)`

Send arguments to the window. They will be serialized with `JSON.stringify`.

### `const dimensions = await win.dimensions()`

Resolves to: `{x <Integer>, y <Integer>, width <Integer>, height <Integer>} | null`.

The height, width, horizontal (`x`), vertical (`y`) position of the window relative to the screen.

All units are (pixels)

If the window is closed this will resolve to `null`.

**References**

* [await win.dimensions(options)](#await-windimensionsoptions-object)

### `await win.dimensions(options <Object>)`

```js
const win = new Pear.Window('./some.html', {
  x: 10,
  y: 450,
  width: 300,
  height: 350
})

await win.open()
await new Promise((resolve) => setTimeout(resolve, 1000))

await win.dimensions({
  x: 20,
  y: 50,
  width: 550,
  height: 300,
})

```

Sets the dimensions of the window.

**Options**

* `x <Integer>` - the horizontal position of left side of the window (pixels)
* `y <Integer>` - the vertical position of the top of the window (pixels)
* `width <Integer>` - the width of the window (pixels)
* `height <Integer>` - the height of the window (pixels)
* `position <String>` - may be `'center'` to set the window in the center of the screen or else `undefined`.

**References**

* [const dimensions = await win.dimensions()](#const-dimensions-await-windimensions)

### `const visible = await win.isVisible()`

Resolves to: `<Boolean>`

Whether the window is visible.

### `const minimized = await win.isMinimized()`

Resolves to: `<Boolean>`

Whether the window is minimized.

### `const maximized = await win.isMaximized()`

Resolves to: `<Boolean>`

Whether the window is maximized.

### `const closed = await win.isClosed()`

Resolves to: `<Boolean>`

Whether the window is closed.

### `const view = new Pear.View(options <Object>)`

Desktop Applications only.

Create a new `View` instance. Views provide isolated content views. Frameless, chromeless windows that can be embedded inside other windows and views.

**Options**

* `x <Integer>` - the horizontal position of left side of the view (pixels)
* `y <Integer>` - vertical view position (pixels)
* `width <Integer>` - the width of the view (pixels)
* `height <Integer>` - the height of the view (pixels)
* `backgroundColor <String>` Default: `'#FFF'` - view default background color. Hex, RGB, RGBA, HSL HSLA, CSS color
* `autoresize <Object>` Default `{ width=true, height=true, vertical=false, horizontal=false }` - dimensions for the view to autoresize alongside. For example, if `width` is `true` and the view container increases/decreases in width, the view will increase/decrease in width at the same rate.

**References**

* <https://www.electronjs.org/docs/latest/api/browser-view#viewsetautoresizeoptions-experimental>
* <https://www.electronjs.org/docs/latest/api/browser-view#viewsetbackgroundcolorcolor-experimental>

### `view.on[ce]('message', (...args) => { })`

### `for await (const [ ...args ] of view)`

Receive a message from the view. The received `args` array is deserialized via `JSON.parse`.

**References**

* [`view.send()`](#await-viewsendargs)

### `const success = await view.open(options <Object>)`

Resolves to: `<Boolean>`

Open the view.

**Options**

* `x <Integer>` - the horizontal position of left side of the view (pixels)
* `y <Integer>` - vertical view position (pixels)
* `width <Integer>` - the width of the view (pixels)
* `height <Integer>` - the height of the view (pixels)
* `backgroundColor <String>` Default: `'#FFF'` - view default background color. Hex, RGB, RGBA, HSL HSLA, CSS color
* `autoresize <Object>` Default `{ width=true, height=true, vertical=false, horizontal=false }` - dimensions for the view to autoresize alongside. For example, if `width` is `true` and the view container increases/decreases in width, the view will increase/decrease in width at the same rate.

### `const success = await view.close()`

Resolves to: `<Boolean>`

Close the view.

### `const success = await view.show()`

Resolves to: `<Boolean>`

Show the view.

### `const success = await view.hide()`

Resolves to: `<Boolean>`

Hide the view.

### `const success = await view.focus()`

Resolves to: `<Boolean>`

Focus the view.

### `const success = await view.blur()`

Resolves to: `<Boolean>`

Blur the view.

### `await view.send(...args)`

Send arguments to the view. They will be serialized with `JSON.stringify`.

### `const dimensions = await view.dimensions()`

Resolves to: `{x <Integer>, y <Integer>, width <Integer>, height <Integer>} | null`.

The height, width, horizontal (`x`), vertical (`y`) position of the window relative to the screen.

All units are (pixels)

If the Window is closed this will resolve to `null`.

**References**

* [await view.dimensions(options)](#await-viewdimensionsoptions-object)

### `await view.dimensions(options <Object>)`

```js
const view = new Pear.View('./some.html', {
  x: 10,
  y: 450,
  width: 300,
  height: 350
})

await view.open()
await new Promise((resolve) => setTimeout(resolve, 1000))

await view.dimensions({
  x: 20,
  y: 50,
  width: 550,
  height: 300
})
```

Sets the dimensions of the view.

**Options**

* `x <Integer>` - the horizontal position of left side of the window (pixels)
* `y <Integer>` - the vertical position of the top of the window (pixels)
* `width <Integer>` - the width of the window (pixels)
* `height <Integer>` - the height of the window (pixels)

**References**

* [const dimensions = await view.dimensions()](#const-dimensions--await-viewdimensions)

### `const visible = await view.isVisible()`

Resolves to: `<Boolean>`

Whether the view is visible.

### `const closed = await view.isClosed()`

Resolves to: `<Boolean>`

Whether the view is closed.

### `const { self } = Pear.Window` `const { self } = Pear.View`

### `const success = await self.focus()`

Resolves to: `<Boolean>`

Focus current view or window.

### `const success = await self.blur()`

Resolves to: `<Boolean>`

Blur current view or window.

### `const success = await self.show()`

Resolves to: `<Boolean>`

Show current view or window.

### `const success = await self.hide()`

Resolves to: `<Boolean>`

Hide current view or window.

### `const success = await self.minimize()`

Resolves to: `<Boolean>`

Minimize current window.

Throws a `TypeError` if `self` is a view.

### `const success = await self.maximize()`

Resolves to: `<Boolean>`

Maximize current window.

Throws a `TypeError` if `self` is a view.

### `const success = await self.restore()`

Resolves to: `<Boolean>`

Unmaximize/unminimize the current window if it is currently maximized/minimized.

Throws a `TypeError` if `self` is a view.

### `const success = await self.close()`

Resolves to: `<Boolean>`

Closes the current view or window.

### `const isVisible = await self.isVisible()`

Resolves to: `<Boolean>`

Whether the current window or view is visible.

### `const isMaximized = await self.isMaximized()`

Resolves to: `<Boolean>`

Whether the current window is maximized. Throws a `TypeError` if `self` is a view.

### `const isMinimized = await self.isMinimized()`

Resolves to: `<Boolean>`

Whether the current window is minimized. Throws a `TypeError` if `self` is a view.

### `const { parent } = Pear.Window` `const { parent } = Pear.View`

### `parent.on[ce]('message', (...args) => { })`

### `for await (const [ ...args ] of parent)`

Receive a message from the parent window or view. The received `args` array is deserialized via `JSON.parse`.

### `await parent.send(...args)`

Send arguments to the parent view or window. They will be serialized with `JSON.stringify`.

### `const success = await parent.focus()`

Resolves to: `<Boolean>`

Focus parent view or window.

### `const success = await parent.blur()`

Resolves to: `<Boolean>`

Blur parent view or window.

### `const success = await parent.show()`

Resolves to: `<Boolean>`

Show parent view or window.

### `const success = await parent.hide()`

Resolves to: `<Boolean>`

Hide parent view or window.

### `const success = await parent.minimize()`

Resolves to: `<Boolean>`

Minimize parent window.

Throws a `TypeError` if `parent` is a view.

### `const success = await parent.maximize()`

Resolves to: `<Boolean>`

Maximize parent window.

Throws a `TypeError` if `parent` is a view.

### `const success = await parent.restore()`

Resolves to: `<Boolean>`

Unmaximize/unminimize the parent window if it is currently maximized/minimized.

Throws a `TypeError` if `parent` is a view.

### `const success = await parent.close()`

Resolves to: `<Boolean>`

Closes the parent view or window.

### `const isVisible = await parent.isVisible()`

Resolves to: `<Boolean>`

Whether the parent window or view is visible.

### `const isMaximized = await parent.isMaximized()`

Resolves to: `<Boolean>`

Whether the parent window is maximized. Throws a `TypeError` if `parent` is a view.

### `const isMinimized = await parent.isMinimized()`

Resolves to: `<Boolean>`

Whether the parent window is minimized. Throws a `TypeError` if `parent` is a view.

## Web APIs

Most [Web APIs](https://developer.mozilla.org/en-US/docs/Web/API) will work as-is.

This section details deviations in behavior from and notable aspects of Web APIs as they relate to Pear.

### `window.open`

The [`window.open`](https://developer.mozilla.org/en-US/docs/Web/API/Window/open) Web API function will ignore all arguments except for the URL parameter.

In browsers, `window.open` opens a new browser window. The opened window belongs to the same browser from which `window.open` is called.

In Pear, `window.open` loads the URL in the **default system browser**. It does *not* create a new application window (use `Pear.Window` to create application windows).

Therefore Pear's `window.open` only supports a single URL argument. The `target` and `windowFeatures` parameters that browsers support are discarded.

### Scripts and Modules

Like browsers, there is no support for CommonJS (e.g. the `require` function as used by Node.js is not supported in Pear Applications).

Like browsers, there is support for native EcmaScript Modules (ESM). A JavaScript Script has no module capabilities. A JavaScript Module has ESM capabilities.

Use `<script type="module" src="path/to/my-file.js">` to load a JavaScript Module.

Use `<script src="path/to/my-file.js">` to load a JavaScript Script.


# Frequently Asked Questions

## How Do I Get a List of Pear Applications I've Installed?

Running the following command in the terminal will list installed applications;

```console
pear data apps
```

It will return a list like the following:

```
- pear://keet
    storage: ./pear/app-storage/by-dkey/197ea022b663edbedcf0b2a0fe44ebc99c21448cb46d375ec77d95de6e0a4c1a

- pear://runtime
    storage: ./pear/app-storage/by-dkey/50f2c1326de970da319534164017f23101c6badd5497a99045f8d9ef13978995

- pear://38cna455dbguiatg46z98cs7b6p4t4sh6hskozuhmipmpkxmmeuy
    storage: ./pear/app-storage/by-dkey/be6ff2fc20eb691af1ff7b90d5848ee1e22d2fe4fab031900e1014e224f659ab
```

For more information about the `pear data apps` command, see the [cli docs](https://docs.pears.com/cli#pear-data-apps-flags-link).

## How Do I Uninstall a Pear Application?

Uninstalling Pear Applications is currently not supported. You can reset the storage for an application via the `pear reset <link>` command. This is a **destructive** command that will permanently delete the storage for the application loosing all data it contains. Use with caution.

For more information about the `pear reset` command, see the [cli docs](https://docs.pears.com/cli#pear-reset-flags-less-than-link-greater-than).

## Where is the Pear Application stored?

The Pear framework, applications and their storage are all within the `pear` directory. The directory's path depends on the operating system:

| OS      | Pear Path                            |
| ------- | ------------------------------------ |
| MacOs   | `~/Library/Application Support/pear` |
| Linux   | `~/.config/pear`                     |
| Windows | `%userprofile%\AppData\Roaming\pear` |

This path can be accessed in a Pear application via [`Pear.config.pearDir`](https://docs.pears.com/api#pear.config.peardir-less-than-string-greater-than).

Within the `pear` directory the Pear framework itself is stored where the `current` symlink points, Pear applications are stored in the `corestores` directory, and Pear application storage (aka [`Pear.config.storage`](https://docs.pears.com/api#pear.config.storage-less-than-string-greater-than) for applications) are stored in `app-storage`.

Note that Pear applications and the Pear platform are stored in a [`corestore`](https://docs.pears.com/helpers/corestore) as [`hyperdrive`](https://docs.pears.com/building-blocks/hyperdrive)s so are not easily inspectable via a file explorer. To see the files distributed with an application use [`pear dump`](https://docs.pears.com/cli#pear-dump-flags-less-than-link-greater-than-less-than-dir-greater-than) to dump its contents as files.

## Can Pear use with X language?

Pear applications currently can only be written in JavaScript, but other languages and libraries can be integrated by adding bindings as a native addon. See the [`bare-addon`](https://github.com/holepunchto/bare-addon) for a template to get started creating a native addon for Bare runtime.

For languages like TypeScript that compile to JavaScript, it is recommended to compile into JavaScript and then load it as the Javascript entrypoint either as the `main` property for a terminal application or as a `<script>` in the HTML entrypoint for a desktop application. For more information about configuring the entrypoint for Pear Application see [here](https://docs.pears.com/configuration#the-package.json-file).

## How Do I Write an Application Once So It Can Be Run on Desktop, Mobile, etc?

The recommendation is to write Pear applications with all the business logic and peer-to-peer (P2P) code in what is called the "Pear-end". This is a separate worker/worklet thread that communicates to the user interface (UI) via an inter-process communication (IPC) stream. By abstracting the UI from the Pear-end, the Pear-end can be reused across all versions of the application with only the UI code changing.

At the moment, the `Pear` Application Programming Interface (API) is not supported in mobile applications. This will change as Pear v2 comes out which uses the separation of Pear-end and UI as the default.

## How is my Application Distributed? Do I have to keep the `seed` command running?

Pear applications are distributed via the swarm so that any peer with the application will reseed it to other peers when they are running the application. To speed up and facilitate replication, it is recommended to run the `pear seed <link>` command to ensure a peer is online and seeding the application.

## Why Is NPM Used For Dependencies?

NPM is a great package manager, many JavaScript developers are already familiar with it and all Holepunch's packages are published on NPM. Dependencies installed in your app should be staged with the Application and then are replicated via the swarm. It is recommended to do a dry run when staging to review the changes to the application. This will include all the changes to the dependencies and so can be used to audit them looking for unexpected updates.

After you install the `pear` via NPM and complete the setup, NPM and Node.js are no longer required to run Pear terminal applications. The `pear` package on NPM is only used to bootstrap the Pear platform. After the setup the `pear` command is using Bare to run the Pear application.

## How Do I Distribute a Binary Version of My Application?

You can make a binary version of a Pear applications using the [`pear-appling`](https://github.com/holepunchto/pear-appling/) template repository. This repository can be configure in `CMakeLists.txt`, providing the metadata for your application, and compiled for MacOS, Linux and Windows. The compiled output is a small binary used to bootstrap the Pear platform and the application replicating the most recent version of them. This way you rarely, if ever, need to recompile your binary. Any future user can download it and will be able to run the most recent version of your application after replicating.

## Can Peers Know My IP Address When Using `hyperswarm` or Swarming a Pear Application?

Your IP is exchanged with peers so that they can connect to you. If you want to protect your IP, it is recommended to use a VPN.
