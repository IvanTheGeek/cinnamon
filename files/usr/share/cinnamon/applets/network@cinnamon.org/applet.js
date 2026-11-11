const Applet = imports.ui.applet;
const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const GObject = imports.gi.GObject;
const Lang = imports.lang;
const Pango = imports.gi.Pango;
const NM = imports.gi.NM;
const Signals = imports.signals;
const St = imports.gi.St;
const Mainloop = imports.mainloop;
const Main = imports.ui.main;
const PopupMenu = imports.ui.popupMenu;
const MessageTray = imports.ui.messageTray;
const ModemManager = imports.misc.modemManager;
const Util = imports.misc.util;
const Settings = imports.ui.settings;

const DEFAULT_PERIODIC_UPDATE_FREQUENCY_SECONDS = 10;
const FAST_PERIODIC_UPDATE_FREQUENCY_SECONDS = 2;

const NMConnectionCategory = {
    INVALID: 'invalid',
    WIRED: 'wired',
    WIRELESS: 'wireless',
    WWAN: 'wwan',
    VPN: 'vpn'
};

const NMAccessPointSecurity = {
    UNKNOWN: 0,
    NONE: 1,
    WEP: 2,
    WPA_PSK: 3,
    WPA2_PSK: 4,
    WPA_ENT: 5,
    WPA2_ENT: 6,
    SAE: 7,
    OWE: 8
};

// The kind shown next to a VPN connection's name, keyed by the last part of
// its plugin's service type (org.freedesktop.NetworkManager.<key>); other
// plugins show the key itself. Plugin names are product and protocol names
// and are left untranslated, so the table adds no strings.
const VPN_KIND_NAMES = {
    fortisslvpn: 'Fortinet SSL VPN',
    l2tp: 'L2TP',
    libreswan: 'IPsec',
    openconnect: 'OpenConnect',
    openswan: 'IPsec',
    openvpn: 'OpenVPN',
    pptp: 'PPTP',
    ssh: 'SSH',
    sstp: 'SSTP',
    strongswan: 'IPsec/IKEv2',
    vpnc: 'Cisco VPN'
};

// small optimization, to avoid using [] all the time
const NM80211Mode = NM['80211Mode'];
const NM80211ApFlags = NM['80211ApFlags'];
const NM80211ApSecurityFlags = NM['80211ApSecurityFlags'];

// number of wireless networks that should be visible
// (the remaining are placed into More...)
const NUM_VISIBLE_NETWORKS = 5;

var NMIface = '\
<node> \
  <interface name="org.freedesktop.NetworkManager"> \
    <method name="CheckConnectivity"> \
      <arg type="u" name="connectivity" direction="out"/> \
    </method> \
  </interface> \
</node>';

var NMProxy = Gio.DBusProxy.makeProxyWrapper(NMIface);
function NMDBus(initCallback, cancellable) {
    return new NMProxy(Gio.DBus.system,
                       'org.freedesktop.NetworkManager',
                       '/org/freedesktop/NetworkManager',
                       initCallback, cancellable);
}

// shared between NMNetworkMenuItem and NMDeviceWWAN
function signalToIcon(value) {
    if (value > 80)
        return 'excellent';
    if (value > 55)
        return 'good';
    if (value > 30)
        return 'ok';
    if (value > 5)
        return 'weak';
    return 'none';
}

/* How NM ranks a link, as [tier, metric]; lower is better:
   [0, 0]       it holds NM's default route (IPv4 or IPv6);
   [1, metric]  it has a default route of its own, at that metric.  Under a
                full tunnel no link holds NM's default, but libnm keeps
                reporting each link's own 0.0.0.0/0 with its metric (seen on
                NM 1.46.0: the cable at 101, the Wi-Fi at 600), and the
                lowest metric is the link NM itself would use;
   [2, 0]       it has an address (e.g. a never-default bench cable);
   [3, 0]       nothing (e.g. a link brought up with IP disabled). */
function linkPreference(a) {
    if (a['default'] || a.default6)
        return [0, 0];

    let hasDefault = false;
    let metric = Number.MAX_SAFE_INTEGER;
    let addressed = false;
    for (let c of [ a.get_ip4_config(), a.get_ip6_config() ]) {
        if (!c)
            continue;
        if (c.get_addresses().length > 0)
            addressed = true;
        for (let r of c.get_routes()) {
            if (r.get_prefix() !== 0)
                continue;
            hasDefault = true;
            // a negative metric means "unset"; rank it after any real one
            if (r.get_metric() >= 0 && r.get_metric() < metric)
                metric = r.get_metric();
        }
    }
    if (hasDefault)
        return [1, metric];
    return [addressed ? 2 : 3, 0];
}

/* The primary line over a panel icon: a 2px top border, matched by 2px of
   bottom padding so the icon stays centred like its neighbours; an icon
   without the line gets 2px of padding at each end instead, so showing the
   line moves nothing.  All four sides get the colour: St paints every side
   in one colour, so "border-top: 2px solid <colour>" over transparent sides
   came out invisible (Cinnamon 6.6.9). */
function primaryLineStyle(color) {
    if (!color)
        return 'padding-top: 2px; padding-bottom: 2px;';
    return 'padding-bottom: 2px; border: 0 solid ' + color + '; border-top-width: 2px;';
}

/* The tunnel glyph, a padlock over a network node, fills much less of its
   box than the bars or the wired glyph, so at the panel's symbolic icon size
   it looks smaller than its neighbours; at the theme's .applet-icon size
   (22px) it was a little too big.  Draw it at this multiple of the panel's
   symbolic icon size instead (Ivan, 2026-11-11). */
const VPN_ICON_SCALE = 1.25;

/* The padlock is also narrower than the node bar under it, so even laid out
   at the other icons' width the tunnel icon looked further from the next
   applet than the other icons are from theirs: 15px from the sound icon at
   the padlock's height, against 11-14px between the other applets (Ivan's
   laptop, 2026-11-11).  Its slot loses this fraction of the icon's size on
   each side, and the icon's group gets the left half back as padding, so
   the icon moves only towards the next applet. */
const VPN_ICON_TRIM = 0.15;

/* Extra space between the panel's link icons, on top of the applet box's
   own spacing, once two or more are shown: with the theme's spacing alone
   they looked closer to each other than to the next applet (Ivan,
   2026-11-11). */
const LINK_ICON_GAP = 3;

/* The kinds of link that get a panel icon of their own, in panel order. */
const LINK_ICON_KINDS = [ NMConnectionCategory.WIRED,
                          NMConnectionCategory.WIRELESS,
                          NMConnectionCategory.VPN ];

/* The tooltip's name for a kind of link, from strings the menu already uses. */
function linkKindTitle(kind) {
    if (kind === NMConnectionCategory.WIRED)
        return _("Wired");
    if (kind === NMConnectionCategory.WIRELESS)
        return _("Wireless");
    return _("VPN");
}

/* An active connection's name as the menu shows it, else libnm's id. */
function activeConnectionName(a) {
    return (a.connection && a.connection._name) ? a.connection._name : a.get_id();
}

/* Whether a connection has a default route of its own (0.0.0.0/0 or ::/0) in
   any routing table.  In WireGuard's default policy-routing mode a full
   tunnel's default route sits in a table of its own and NM's default flag
   stays on the link (seen on NM 1.46.0: "0.0.0.0/0 table 51936"), so the flag
   alone does not tell such a tunnel from a split one. */
function hasDefaultRoute(a) {
    for (let c of [ a.get_ip4_config(), a.get_ip6_config() ]) {
        if (c && c.get_routes().some(r => r.get_prefix() === 0))
            return true;
    }
    return false;
}

/* The connection that carries the default route: a tunnel that takes all
   traffic (it holds NM's default, or has a default route of its own), else
   the connection holding NM's default.  null when none has one. */
function primaryConnection(activeConnections) {
    let up = activeConnections.filter(a => a._section &&
                                           a.state === NM.ActiveConnectionState.ACTIVATED);
    let tunnels = up.filter(a => a._section === NMConnectionCategory.VPN);
    let full = tunnels.find(a => a['default'] || a.default6) || tunnels.find(hasDefaultRoute);
    if (full)
        return full;

    return up.find(a => a._section !== NMConnectionCategory.VPN &&
                        (a['default'] || a.default6)) || null;
}

/* The link NM prefers among `links` (see linkPreference()).  Ties keep NM's
   order, which lists the newest connection first. */
function preferredLink(links) {
    let best = null;
    let bestKey = null;
    for (let a of links) {
        let key = linkPreference(a);
        if (!best || key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) {
            best = a;
            bestKey = key;
        }
    }
    return best;
}

/* '-secure' when the access point is encrypted, '' when it is open.
   _getApSecurityType() lives on NMDeviceWireless and caches its answer on the
   access point, so pass the device wrapper when there is one. */
function apSecuritySuffix(dev, ap) {
    if (!ap)
        return '';

    let type = (dev && dev._getApSecurityType) ? dev._getApSecurityType(ap)
                                               : ap._secType;

    return (type != NMAccessPointSecurity.UNKNOWN &&
            type != NMAccessPointSecurity.NONE) ? '-secure' : '';
}

// shared between NMNetworkMenuItem and NMDeviceWireless
function sortAccessPoints(accessPoints) {
    return accessPoints.sort(function (one, two) {
        return two.strength - one.strength;
    });
}

function ssidToLabel(ssid) {
    let label = NM.utils_ssid_to_utf8(ssid.get_data());
    if (!label)
        label = _("<unknown>");
    return label;
}

/* Frequency (MHz) -> band.  The 5 GHz band tops out at 5895; U-NII-5, the
   bottom of 6 GHz, starts at 5925.  NM has no 6 GHz helper of its own. */
function bandOfFrequency(freq) {
    if (!freq)
        return null;
    if (freq < 2500)
        return '2.4';
    if (freq < 5925)
        return '5';
    return '6';
}

/* The distinct bands an SSID is reachable on, low to high. */
function bandsOfAccessPoints(accessPoints) {
    let seen = { };
    for (let i = 0; i < accessPoints.length; i++) {
        let b = bandOfFrequency(accessPoints[i].get_frequency());
        if (b)
            seen[b] = true;
    }
    return ['2.4', '5', '6'].filter(b => seen[b]);
}

/* What the wifi rows show.  Mirrored here from the applet's settings because
   the menu items hold no reference back to the applet. */
let ROW_OPTS = { band: true, width: false, security: false, percent: true };

/* The active connection that carries the default route (primaryConnection()),
   mirrored here for the menu rows for the same reason.  Set by the applet. */
let PRIMARY_CONNECTION = null;

/* The tooltip's mark for the connection that carries the default route. */
function markPrimary(text, isPrimary) {
    return isPrimary ? text + " *" : text;
}

/* The menu's mark for it: an asterisk right before the row's switch.  A
   PopupSwitchMenuItem holds its switch alone in _statusBin (the same on
   6.6.9 and master), so wrap the switch once in a box with the mark in
   front of it.  The row's status text stays where it is. */
/* Call before a menu section's rows are destroyed.  When one of them holds
   the key focus (the pointer is over it, or its switch was just flipped,
   which leaves the menu open), move the focus to the section itself:
   destroying the row would take the focus out of the menu, and Cinnamon
   closes a menu that loses the focus (PopupMenuManager._onKeyFocusChanged).
   Flipping one VPN switch closed the menu when NM's change rebuilt the
   rows (Ivan, 2026-11-11). */
function keepFocusInSection(section) {
    let focus = global.stage.get_key_focus();
    if (focus && focus !== section.actor && section.actor.contains(focus))
        section.actor.grab_key_focus();
}

function setSwitchMark(item, on) {
    if (!item._primaryMark) {
        if (!on)
            return;
        let sw = item._switch.actor;
        item._statusBin.set_child(null);
        let box = new St.BoxLayout({ style: 'spacing: 6px;' });
        item._primaryMark = new St.Label({ text: "*" });
        box.add(item._primaryMark, { y_align: St.Align.MIDDLE, y_fill: false });
        box.add(sw, { y_align: St.Align.MIDDLE, y_fill: false });
        item._statusBin.set_child(box);
    }
    item._primaryMark.visible = on;
}

/* Cap on the SSID column.  Without one the menu simply grows to fit the longest
   name in range -- a single "DO_NOT_CONNECT_MESH-FX4100-1CD8" was measured at
   250px and dragged the whole panel out with it, and stock has the same problem.
   St does NOT honour "max-width" for a label's preferred width (verified: a
   250px label still reports 250 under max-width:150), so the cap has to be
   applied as an explicit "width" and only when the natural width exceeds it --
   otherwise every short SSID would be padded out to the cap and the menu would
   get WIDER in the common case. */
const MAX_SSID_WIDTH = 190;
const MAX_SSID_CHARS = 24;

/* Security label straight from the scan, as text for the row.  Classify from
   the raw flags and distinguish personal from enterprise -- PSK vs
   KEY_MGMT_802_1X is exactly that distinction. */
function apSecurityLabel(ap) {
    const F = NM80211ApSecurityFlags;
    let rsn = ap.rsn_flags, wpa = ap.wpa_flags;

    if (rsn != F.NONE) {
        if (rsn & F.KEY_MGMT_EAP_SUITE_B_192)
            return 'WPA3-Ent';
        if ((rsn & F.KEY_MGMT_SAE) && (rsn & F.KEY_MGMT_PSK))
            return 'WPA2/3';          // transition mode, what nmcli calls "WPA2 WPA3"
        if (rsn & F.KEY_MGMT_SAE)
            return 'WPA3';
        if ((rsn & F.KEY_MGMT_OWE) || (rsn & F.KEY_MGMT_OWE_TM))
            return 'OWE';             // Enhanced Open -- encrypted but no key
        if (rsn & F.KEY_MGMT_802_1X)
            return 'WPA2-Ent';
        return 'WPA2';
    }

    if (wpa != F.NONE)
        return (wpa & F.KEY_MGMT_802_1X) ? 'WPA-Ent' : 'WPA';

    if (ap.flags & NM80211ApFlags.PRIVACY)
        return 'WEP';

    return 'Open';
}

function NMNetworkMenuItem() {
    this._init.apply(this, arguments);
}

function default_to_private_connections(client) {
    let perms = client.get_permission_result (NM.ClientPermission.SETTINGS_MODIFY_SYSTEM);
    return (perms != NM.ClientPermissionResult.YES);
}

NMNetworkMenuItem.prototype = {
    __proto__: PopupMenu.PopupBaseMenuItem.prototype,

    _init: function(accessPoints, title, params) {
        PopupMenu.PopupBaseMenuItem.prototype._init.call(this, params);

        accessPoints = sortAccessPoints(accessPoints);
        this.bestAP = accessPoints[0];
        this._allAps = accessPoints;
        this._activeAp = null;

        this._label = new St.Label({ text: title });
        this.addActor(this._label);
        this._icons = new St.BoxLayout({ style_class: 'nm-menu-item-icons' });
        /* span: -1 makes availWidth run to the item's right edge, and expand
           gives the box all of it, so the bars end at that edge, in line with
           the switches on the other rows, whatever the box's own preferred
           width says.  The meta text inside takes up the slack (below).
           Placing the box by its preferred width instead (align END) let a
           stale width push the bars left: on the laptop the bold active row's
           box was placed at 235px against a real 243, and the bars sat 8px
           left of the column, overlapping the text (2026-11-11). */
        this.addActor(this._icons, { span: -1, expand: true });

        /* The band/strength text goes INSIDE the icon box rather than taking a
           column of its own.  PopupBaseMenuItem inserts `spacing` between every
           column -- 1em under Mint-Y, ~13px at Ubuntu 10 -- so a third column
           cost two full gaps.  Inside the box it is separated by
           .nm-menu-item-icons' .5em instead, returning roughly 1.5em of width
           to the SSID, which is the column that actually needs it. */
        this._labelStrength = new St.Label({ text: this._metaText() });
        /* Never ellipsize the band/strength text.  St.Label defaults to
           ellipsize END, so on the widest row the meta was truncating to
           "2.4\u00b75 GHz\u2026" -- which reads as a broken column even though the
           icon itself stays put.  The SSID keeps the default and gives way
           instead: a clipped network name is far less harmful than a clipped
           signal reading, and it keeps the bars pinned right. */
        this._labelStrength.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        // takes the box's slack and sits at its right end, against the bars
        this._icons.add(this._labelStrength, { expand: true, x_fill: false, x_align: St.Align.END,
                                               y_align: St.Align.MIDDLE, y_fill: false });

        this._signalIcon = new St.Icon({ icon_name: this._getIcon(),
                                         style_class: 'popup-menu-icon' });
        this._icons.add_actor(this._signalIcon);

        this._accessPoints = [ ];
        for (let i = 0; i < accessPoints.length; i++) {
            let ap = accessPoints[i];
            // need a wrapper object here, because the access points can be shared
            // between many NMNetworkMenuItems
            let apObj = {
                ap: ap,
                updateId: ap.connect('notify::strength', Lang.bind(this, this._updated))
            };
            this._accessPoints.push(apObj);
        }

        /* Also cap here, not only from _refreshMeta(): rows that overflow into
           the "More" submenu may never receive a strength update, and their
           uncapped width still sizes the whole menu. */
        this._capLabelWidth();
    },

    _updated: function(ap) {
        if (ap.strength > this.bestAP.strength)
            this.bestAP = ap;

        this._signalIcon.icon_name = this._getIcon();
        this._refreshMeta();
    },

    /* "2.4\u00b7[5]\u00b76 GHz \u00b7 75%" -- every band this SSID is on, with the
       one we are associated to in brackets.  Brackets rather than bold: no
       Pango markup to escape, and no reliance on the panel theme's weights. */
    _metaText: function() {
        let parts = [];

        if (ROW_OPTS.band) {
            let aps = (this._allAps && this._allAps.length) ? this._allAps : [ this.bestAP ];
            let bands = bandsOfAccessPoints(aps);
            let activeBand = this._activeAp ? bandOfFrequency(this._activeAp.get_frequency()) : null;
            if (bands.length)
                parts.push(bands.map(b => (b === activeBand ? '[' + b + ']' : b)).join('\u00b7') + ' GHz');
        }

        /* Channel width is a property of ONE access point, so on a merged
           multi-band row this is the width of the strongest one only. */
        if (ROW_OPTS.width && this.bestAP.bandwidth)
            parts.push(this.bestAP.bandwidth + ' MHz');

        if (ROW_OPTS.security)
            parts.push(apSecurityLabel(this.bestAP));

        if (ROW_OPTS.percent)
            parts.push(String(this.bestAP.strength) + '%');

        return parts.join(' \u00b7 ');
    },

    /* Setting the text is NOT enough.  The icon box caches a preferred width,
       and it does not get invalidated when the child label's text changes, so
       the menu's columns would be sized from the old text -- "2.4\u00b75 GHz \u00b7
       100%" -> "99%" happens on every signal update, ~8/min.  queue_relayout()
       drops the cached size.  (The bars stay at the right edge either way:
       the box fills the row; see _init.) */
    _refreshMeta: function() {
        this._labelStrength.set_text(this._metaText());
        this._icons.queue_relayout();
        this._capLabelWidth();
    },

    /* Hand-rolled max-width for the SSID (see MAX_SSID_WIDTH).
       Deliberately keyed off TEXT LENGTH, not a measurement.  St applies neither
       set_style() nor set_text() synchronously, so get_preferred_width() right
       after either one returns a stale number -- measured live, a 31-character
       name reported 43px immediately after set_text(), and a cleared style still
       reported the old capped width.  Both make a measure-then-decide cap
       oscillate or latch wrongly.  Character count needs no realized actor and
       is stable on repeat calls; ~24 characters is about MAX_SSID_WIDTH in the
       default panel font. */
    _capLabelWidth: function() {
        if (this._label.get_text().length > MAX_SSID_CHARS)
            this._label.set_style('width: ' + MAX_SSID_WIDTH + 'px;');
    },

    setActiveAp: function(ap) {
        this._activeAp = ap || null;
        this._refreshMeta();
    },

    _getIcon: function() {
        if (this.bestAP.mode == NM80211Mode.ADHOC)
            return 'xsi-network-workgroup';
        else if (this.bestAP._secType != NMAccessPointSecurity.UNKNOWN &&
            this.bestAP._secType != NMAccessPointSecurity.NONE)
            return 'xsi-network-wireless-signal-' + signalToIcon(this.bestAP.strength) + '-secure';
        else
            return 'xsi-network-wireless-signal-' + signalToIcon(this.bestAP.strength);
    },

    updateAccessPoints: function(accessPoints) {
        for (let i = 0; i < this._accessPoints.length; i++) {
            let apObj = this._accessPoints[i];
            apObj.ap.disconnect(apObj.updateId);
            apObj.updateId = 0;
        }

        accessPoints = sortAccessPoints(accessPoints);
        this.bestAP = accessPoints[0];
        this._allAps = accessPoints;
        this._accessPoints = [ ];
        for (let i = 0; i < accessPoints.length; i++) {
            let ap = accessPoints[i];
            let apObj = {
                ap: ap,
                updateId: ap.connect('notify::strength', Lang.bind(this, this._updated))
            };
            this._accessPoints.push(apObj);
        }

        this._refreshMeta();
    },

    destroy: function() {
        for (let i = 0; i < this._accessPoints.length; i++) {
            let apObj = this._accessPoints[i];
            apObj.ap.disconnect(apObj.updateId);
            apObj.updateId = 0;
        }

        PopupMenu.PopupBaseMenuItem.prototype.destroy.call(this);
    }
};

function NMWiredSectionTitleMenuItem() {
    this._init.apply(this, arguments);
}

NMWiredSectionTitleMenuItem.prototype = {
    __proto__: PopupMenu.PopupSwitchMenuItem.prototype,

    _init: function(label, params) {
        params = params || { };
        params.style_class = 'popup-subtitle-menu-item';
        PopupMenu.PopupSwitchMenuItem.prototype._init.call(this, label, false, params);
    },

    updateForDevice: function(device) {
        if (device) {
            this._device = device;
            this.setStatus(device.statusLabel);
            this.setToggleState(device.connected);
            // if this device is not controllable, hide the switch
            this._switch.actor.visible = device.controllable;
        } else {
            this.setStatus('');
            this._switch.actor.visible = false;
        }
        setSwitchMark(this, device ? device.isPrimary : false);
    },

    activate: function(event) {
        PopupMenu.PopupSwitchMenuItem.prototype.activate.call(this, event);

        if (!this._device) {
            log('Section title activated when there is more than one device, should be non reactive');
            return;
        }

        let newState = this._switch.state;

        // Immediately reset the switch to false, it will be updated appropriately
        // by state-changed signals in devices (but fixes the VPN not being in sync
        // if the ActiveConnection object is never seen by libnm-glib)
        this._switch.setToggleState(false);

        if (newState)
            this._device.activate();
        else
            this._device.deactivate();
    }
};

function NMWirelessSectionTitleMenuItem() {
    this._init.apply(this, arguments);
}

NMWirelessSectionTitleMenuItem.prototype = {
    __proto__: PopupMenu.PopupSwitchMenuItem.prototype,

    _init: function(client, property, title, params) {
        params = params || { };
        params.style_class = 'popup-subtitle-menu-item';
        PopupMenu.PopupSwitchMenuItem.prototype._init.call(this, title, false, params);

        this._client = client;
        this._property = property + '_enabled';
        this._propertyHardware = property + '_hardware_enabled';
        this._setEnabledFunc = property + '_set_enabled';

        this._client.connect('notify::' + property + '-enabled', Lang.bind(this, this._propertyChanged));
        this._client.connect('notify::' + property + '-hardware-enabled', Lang.bind(this, this._propertyChanged));

        this._propertyChanged();
    },

    updateForDevice: function(device) {
        this._device = device;
        // we show the switch
        // - if there not just one device
        // - if the switch is off
        // - if the device is activated or disconnected
        if (device && this._softwareEnabled && this._hardwareEnabled) {
            this.setStatus(device.statusLabel);
            this._switch.actor.visible = device.controllable;
        } else {
            this.setStatus(null);
            this._switch.actor.show();
        }
        setSwitchMark(this, device ? device.isPrimary : false);
    },

    activate: function(event) {
        PopupMenu.PopupSwitchMenuItem.prototype.activate.call(this, event);

        this._client[this._setEnabledFunc](this._switch.state);

        if (!this._device) {
            log('Section title activated when there is more than one device, should be non reactive');
            return;
        }

        let newState = this._switch.state;

        if (newState)
            this._device.activate();
        else
            this._device.deactivate();

        this.emit('enabled-changed', this._switch.state);
    },

    _propertyChanged: function() {
        this._softwareEnabled = this._client[this._property];
        this._hardwareEnabled = this._client[this._propertyHardware];

        let enabled = this._softwareEnabled && this._hardwareEnabled;
        this.setToggleState(enabled);
        if (!this._hardwareEnabled)
            /* Translators: this indicates that wireless or wwan is disabled by hardware killswitch */
            this.setStatus(_("disabled"));

        this.emit('enabled-changed', enabled);
    }
};

function NMDevice() {
    throw new TypeError('Instantanting abstract class NMDevice');
}

NMDevice.prototype = {
    _init: function(client, device, connections) {
        this.device = device;
        if (device) {
            this.device._delegate = this;
            this._stateChangedId = this.device.connect('state-changed', Lang.bind(this, this._deviceStateChanged));
        } else
            this._stateChangedId = 0;

        // protected
        this._client = client;
        this._connections = [ ];
        for (let i = 0; i < connections.length; i++) {
            if (!connections[i]._uuid)
                continue;
            if (!this.connectionValid(connections[i]))
                continue;
            // record the connection
            let obj = {
                connection: connections[i],
                name: connections[i]._name,
                uuid: connections[i]._uuid,
                timestamp: connections[i]._timestamp,
            };
            this._connections.push(obj);
        }
        this._connections.sort(this._connectionSortFunction);
        this._activeConnection = null;
        this._activeConnectionItem = null;
        this._autoConnectionItem = null;
        this._overflowItem = null;

        this._carrierChangedId = 0;
        this._firmwareChangedId = 0;
        this._firmwareMissingId = 0;

        if (this.device) {
            this.statusItem = new PopupMenu.PopupSwitchMenuItem(this._getDescription(), this.connected, { style_class: 'popup-subtitle-menu-item' });
            this._statusChanged = this.statusItem.connect('toggled', Lang.bind(this, function(item, state) {
                if (state)
                    this.activate();
                else
                    this.deactivate();
                this.emit('enabled-changed');
            }));

            this._updateStatusItem();
        }
        this.section = new PopupMenu.PopupMenuSection();

        this._createSection();
    },

    destroy: function() {
        if (this.device)
            this.device._delegate = null;

        if (this._stateChangedId) {
            // Need to go through GObject.Object.prototype because
            // nm_device_disconnect conflicts with g_signal_disconnect
            GObject.Object.prototype.disconnect.call(this.device, this._stateChangedId);
            this._stateChangedId = 0;
        }
        if (this._carrierChangedId) {
            // see above for why this is needed
            GObject.Object.prototype.disconnect.call(this.device, this._carrierChangedId);
            this._carrierChangedId = 0;
        }
        if (this._firmwareChangedId) {
            GObject.Object.prototype.disconnect.call(this.device, this._firmwareChangedId);
            this._firmwareChangedId = 0;
        }
        if (this._firmwareMissingId) {
            GObject.Object.prototype.disconnect.call(this.device, this._firmwareMissingId);
            this._firmwareMissingId = 0;
        }

        this._clearSection();
        if (this.statusItem)
            this.statusItem.destroy();
        this.section.destroy();
    },

    deactivate: function() {
        this.device.disconnect_async(null, null);
    },

    activate: function() {
        if (this._activeConnection)
            // nothing to do
            return;

        // pick the most recently used connection and connect to that
        // or if no connections ever set, create an automatic one
        if (this._connections.length > 0) {
            this._client.activate_connection_async(this._connections[0].connection, this.device, null, null, null);
        } else if (this._autoConnectionName) {
            let connection = this._createAutomaticConnection();
            if (connection)
                this._client.add_and_activate_connection_async(connection, this.device, null, null, null);
        }
    },

    get connected() {
        return this.device.state == NM.DeviceState.ACTIVATED;
    },

    setActiveConnection: function(activeConnection) {
        if (activeConnection == this._activeConnection)
            // nothing to do
            return;

        // remove any UI
        if (this._activeConnectionItem) {
            this._activeConnectionItem.destroy();
            this._activeConnectionItem = null;
        }

        this._activeConnection = activeConnection;

        this._clearSection();
        this._createSection();
    },

    checkConnection: function(connection) {
        let pos = this._findConnection(connection._uuid);
        let exists = pos != -1;
        let valid = this.connectionValid(connection);
        if (exists && !valid) {
            this.removeConnection(connection);
        } else if (!exists && valid) {
            this.addConnection(connection);
        } else if (exists) {
            // edited in place -- most visibly, renamed
            let obj = this._connections[pos];
            obj.timestamp = connection._timestamp;
            if (obj.name !== connection._name) {
                obj.name = connection._name;
                this._connections.sort(this._connectionSortFunction);
                this._clearSection();
                this._createSection();
            }
        }
    },

    addConnection: function(connection) {
        // record the connection
        let obj = {
            connection: connection,
            name: connection._name,
            uuid: connection._uuid,
            timestamp: connection._timestamp,
        };
        this._connections.push(obj);
        this._connections.sort(this._connectionSortFunction);

        this._clearSection();
        this._createSection();
    },

    removeConnection: function(connection) {
        if (!connection._uuid) {
            log('Cannot remove a connection without an UUID');
            return;
        }
        let pos = this._findConnection(connection._uuid);
        if (pos == -1) {
            // this connection was never added, nothing to do here
            return;
        }

        let obj = this._connections[pos];
        if (obj.item)
            obj.item.destroy();
        this._connections.splice(pos, 1);

        if (this._connections.length <= 1) {
            // We need to show the automatic connection again
            // (or in the case of NMDeviceWired, we want to hide
            // the only explicit connection)
            this._clearSection();
            this._createSection();
        }
    },

    connectionValid: function(connection) {
        return this.device.connection_valid(connection);
    },

    _connectionSortFunction: function(one, two) {
        if (one.timestamp == two.timestamp)
            return GLib.utf8_collate(one.name, two.name);

        return two.timestamp - one.timestamp;
    },

    setEnabled: function(enabled) {
        // do nothing by default, we want to keep the connection list visible
        // in the majority of cases (wired, wwan, vpn)
    },

    /* Whether this device's connection carries the default route.  Its own
       row, or the section heading that stands in for a lone device, then
       shows the mark (see setSwitchMark()). */
    get isPrimary() {
        return this._activeConnection != null &&
               this._activeConnection === PRIMARY_CONNECTION;
    },

    get statusLabel(){
        switch(this.device.state) {
        case NM.DeviceState.DISCONNECTED:
        case NM.DeviceState.ACTIVATED:
            return null;
        case NM.DeviceState.UNMANAGED:
            /* Translators: this is for network devices that are physically present but are not
               under NetworkManager's control (and thus cannot be used in the menu) */
            return _("unmanaged");
        case NM.DeviceState.DEACTIVATING:
            return _("disconnecting...");
        case NM.DeviceState.PREPARE:
        case NM.DeviceState.CONFIG:
        case NM.DeviceState.IP_CONFIG:
        case NM.DeviceState.IP_CHECK:
        case NM.DeviceState.SECONDARIES:
            return _("connecting...");
        case NM.DeviceState.NEED_AUTH:
            /* Translators: this is for network connections that require some kind of key or password */
            return _("authentication required");
        case NM.DeviceState.UNAVAILABLE:
            // This state is actually a compound of various states (generically unavailable,
            // firmware missing, carrier not available), that are exposed by different properties
            // (whose state may or may not updated when we receive state-changed).
            if (!this._firmwareMissingId)
                this._firmwareMissingId = this.device.connect('notify::firmware-missing', Lang.bind(this, this._substateChanged));
            if (this.device.firmware_missing) {
                /* Translators: this is for devices that require some kind of firmware or kernel
                   module, which is missing */
                return _("firmware missing");
            }
            if (this.device.capabilities & NM.DeviceCapabilities.CARRIER_DETECT) {
                if (!this._carrierChangedId)
                    this._carrierChangedId = this.device.connect('notify::carrier', Lang.bind(this, this._substateChanged));
                if (!this.carrier) {
                    /* Translators: this is for wired network devices that are physically disconnected */
                    return _("cable unplugged");
                }
            }
            /* Translators: this is for a network device that cannot be activated (for example it
               is disabled by rfkill, or it has no coverage */
            return _("unavailable");
        case NM.DeviceState.FAILED:
            return _("connection failed");
        default:
            log('Device state invalid, is %d'.format(this.device.state));
            return 'invalid';
        }
    },

    get controllable(){
        // controllable for every state except unavailable or unmanaged
        if(this.device.state === NM.DeviceState.UNAVAILABLE || this.device.state === NM.DeviceState.UNMANAGED)
            return false;

        return true;
    },

    // protected
    _createAutomaticConnection: function() {
        throw new TypeError('Invoking pure virtual function NMDevice.createAutomaticConnection');
    },

    _findConnection: function(uuid) {
        for (let i = 0; i < this._connections.length; i++) {
            let obj = this._connections[i];
            if (obj.uuid == uuid)
                return i;
        }
        return -1;
    },

    _clearSection: function() {
        // Clear everything
        keepFocusInSection(this.section);
        this.section.removeAll();
        this._autoConnectionItem = null;
        this._activeConnectionItem = null;
        this._overflowItem = null;
        for (let i = 0; i < this._connections.length; i++) {
            this._connections[i].item = null;
        }
    },

    _shouldShowConnectionList: function() {
        return (this.device.state >= NM.DeviceState.DISCONNECTED);
    },

    _createSection: function() {
        if (!this._shouldShowConnectionList())
            return;

        if (this._activeConnection) {
            this._createActiveConnectionItem();
            this.section.addMenuItem(this._activeConnectionItem);
        }
        if (this._connections.length > 0) {
            let activeOffset = this._activeConnectionItem ? 1 : 0;

            for(let j = 0; j < this._connections.length; ++j) {
                let obj = this._connections[j];
                if (this._activeConnection &&
                    obj.connection == this._activeConnection.connection) {
                    activeOffset = 0; // we no longer need to account for this
                    continue;
                }
                obj.item = this._createConnectionItem(obj);
                this._addConnectionItem(obj.item, j + activeOffset);
            }
        } else if (this._autoConnectionName) {
            this._autoConnectionItem = new PopupMenu.PopupMenuItem(this._autoConnectionName);
            this._autoConnectionItem.connect('activate', Lang.bind(this, function() {
                let connection = this._createAutomaticConnection();
                if (connection)
                    this._client.add_and_activate_connection_async(connection, this.device, null, null, null);
            }));
            this.section.addMenuItem(this._autoConnectionItem);
        }
    },

    _addConnectionItem: function(item, position) {
        if (position < NUM_VISIBLE_NETWORKS) {
            this.section.addMenuItem(item);
            return;
        }

        if (!this._overflowItem) {
            this._overflowItem = new PopupMenu.PopupSubMenuMenuItem(_("More"));
            this.section.addMenuItem(this._overflowItem);
        }
        this._overflowItem.menu.addMenuItem(item);
    },

    _createConnectionItem: function(obj) {
        let connection = obj.connection;
        let item = new PopupMenu.PopupMenuItem(obj.name);

        item.connect('activate', Lang.bind(this, function() {
            this._client.activate_connection_async(connection, this.device, null, null, null);
        }));
        return item;
    },

    _createActiveConnectionItem: function() {
        let title;
        let active = this._activeConnection.connection;
        if (active) {
            title = active._name;
        } else {
            /* Translators: this is the indication that a connection for another logged in user is active,
               and we cannot access its settings (including the name) */
            title = _("Connected (private)");
        }
        this._activeConnectionItem = new PopupMenu.PopupMenuItem(title, { reactive: false });
        this._activeConnectionItem.setShowDot(true);
        this._activeConnectionItem.actor.add_style_class_name('popup-device-menu-item');
    },

    _deviceStateChanged: function(device, newstate, oldstate, reason) {
        if (newstate == oldstate) {
            log('device emitted state-changed without actually changing state');
            return;
        }

        if (oldstate == NM.DeviceState.ACTIVATED) {
            this.emit('network-lost');
        }

        if (newstate == NM.DeviceState.FAILED) {
            this.emit('activation-failed', reason);
        }

        this._updateStatusItem();

        this._clearSection();
        this._createSection();
        this.emit('state-changed');
    },

    _updateStatusItem: function() {
        if (this._carrierChangedId) {
            // see above for why this is needed
            GObject.Object.prototype.disconnect.call(this.device, this._carrierChangedId);
            this._carrierChangedId = 0;
        }
        if (this._firmwareChangedId) {
            GObject.Object.prototype.disconnect.call(this.device, this._firmwareChangedId);
            this._firmwareChangedId = 0;
        }

        this.statusItem.setStatus(this.statusLabel);
        this.statusItem.setToggleState(this.connected);
        setSwitchMark(this.statusItem, this.isPrimary);
        // if this device is not controllable, hide the switch
        this.statusItem._switch.actor.visible = this.controllable;
    },

    _substateChanged: function() {
        this.statusItem.setStatus(this.statusLabel);
        this.statusItem._switch.actor.visible = this.controllable;

        this.emit('state-changed');
    },

    _getDescription: function() {
        let dev_product = this.device.get_product();
        let dev_vendor = this.device.get_vendor();
        if (!dev_product || !dev_vendor) {
            if (this.device.name) {
                return this.device.name;
            }
            else {
                switch (this.device.get_device_type()) {
                    case NM.DeviceType.ETHERNET: return _("Ethernet");
                    case NM.DeviceType.WIFI: return _("Wifi");
                    case NM.DeviceType.MODEM: return _("Modem");
                    case NM.DeviceType.BT: return _("Bluetooth");
                    case NM.DeviceType.WIREGUARD: return _("WireGuard");
                    default: return "";
                }
            }
        }

        let product = Util.fixupPCIDescription(dev_product);
        let vendor = Util.fixupPCIDescription(dev_vendor);
        let out = '';

        // Another quick hack; if all of the fixed up vendor string
        // is found in product, ignore the vendor.
        if (product.indexOf(vendor) == -1)
            out += vendor + ' ';
        out += product;

        return out;
    }
};
Signals.addSignalMethods(NMDevice.prototype);


function NMDeviceWired() {
    this._init.apply(this, arguments);
}

NMDeviceWired.prototype = {
    __proto__: NMDevice.prototype,

    _init: function(client, device, connections) {
        this._autoConnectionName = _("Auto Ethernet");
        this.category = NMConnectionCategory.WIRED;

        NMDevice.prototype._init.call(this, client, device, connections);

        if (this.device && this.device.get_speed) {
            this._speedChangedId = this.device.connect('notify::speed', () => {
                if (this.statusItem)
                    this.statusItem.setStatus(this.statusLabel);
                this.emit('state-changed');
            });
        }
    },

    /* NMDevice.statusLabel is null for both ACTIVATED and DISCONNECTED, so a
       connected wired row shows the adapter name and nothing else.  Show the
       negotiated link speed instead. */
    get statusLabel() {
        if (this.device.state == NM.DeviceState.ACTIVATED && this.device.get_speed) {
            let mbits = this.device.get_speed();
            if (mbits > 0) {
                if (mbits >= 1000) {
                    let gb = mbits / 1000;
                    return ((gb % 1) ? gb.toFixed(1) : String(gb)) + " Gb/s";
                }
                return mbits + " Mb/s";
            }
        }
        return Object.getOwnPropertyDescriptor(NMDevice.prototype, 'statusLabel').get.call(this);
    },

    destroy: function() {
        if (this._speedChangedId) {
            // see NMDevice.destroy() for why this goes through GObject.Object
            GObject.Object.prototype.disconnect.call(this.device, this._speedChangedId);
            this._speedChangedId = 0;
        }

        NMDevice.prototype.destroy.call(this);
    },

    _createSection: function() {
        NMDevice.prototype._createSection.call(this);

        // if we have only one connection (normal or automatic)
        // we hide the connection list, and use the switch to control
        // the device
        // we can do it here because addConnection and removeConnection
        // both call _createSection at some point
        if (this._connections.length <= 1)
            this.section.actor.hide();
        else
            this.section.actor.show();
    },

    _createAutomaticConnection: function() {
        let connection = new NM.SimpleConnection();
        connection._uuid = NM.utils_uuid_generate();
        connection.add_setting(new NM.SettingWired());
        let setting_conn = new NM.SettingConnection({
            uuid: connection._uuid,
            id: this._autoConnectionName,
            type: NM.SETTING_WIRED_SETTING_NAME,
            autoconnect: true
        });
        setting_conn.add_permission('user', GLib.get_user_name(), null);
        connection.add_setting(setting_conn);
        return connection;
    }
};

function NMDeviceModem() {
    this._init.apply(this, arguments);
}

NMDeviceModem.prototype = {
    __proto__: NMDevice.prototype,

    _init: function(client, device, connections) {
        let is_wwan = false;

        this._enabled = true;
        this.mobileDevice = null;
        this._connectionType = 'ppp';

        this._capabilities = device.current_capabilities;
        // Support new ModemManager1 devices
        if (device.udi.indexOf('/org/freedesktop/ModemManager1/Modem') == 0) {
            try {
                is_wwan = true;
                this.mobileDevice = new ModemManager.BroadbandModem(device.udi, device.current_capabilities);
                if (this._capabilities & NM.DeviceModemCapabilities.GSM_UMTS) {
                    this._connectionType = NM.SETTING_GSM_SETTING_NAME;
                } else if (this._capabilities & NM.DeviceModemCapabilities.LTE) {
                    this._connectionType = NM.SETTING_GSM_SETTING_NAME;
                } else if (this._capabilities & NM.DeviceModemCapabilities.CDMA_EVDO) {
                    this._connectionType = NM.SETTING_CDMA_SETTING_NAME;
                }
            }
            catch (e){
                global.logError(e);
            }
        } else if (this._capabilities & NM.DeviceModemCapabilities.GSM_UMTS) {
            is_wwan = true;
            this.mobileDevice = new ModemManager.ModemGsm(device.udi);
            this._connectionType = NM.SETTING_GSM_SETTING_NAME;
        } else if (this._capabilities & NM.DeviceModemCapabilities.CDMA_EVDO) {
            is_wwan = true;
            this.mobileDevice = new ModemManager.ModemCdma(device.udi);
            this._connectionType = NM.SETTING_CDMA_SETTING_NAME;
        } else if (this._capabilities & NM.DeviceModemCapabilities.LTE) {
            is_wwan = true;
            // FIXME: support signal quality
        }

        if (is_wwan) {
            this.category = NMConnectionCategory.WWAN;
            this._autoConnectionName = _("Auto broadband");
        } else {
            this.category = NMConnectionCategory.WIRED;
            this._autoConnectionName = _("Auto dial-up");
        }

        if (this.mobileDevice) {
            this._operatorNameId = this.mobileDevice.connect('notify::operator-name', Lang.bind(this, function() {
                if (this._operatorItem) {
                    let name = this.mobileDevice.operator_name;
                    if (name) {
                        this._operatorItem.label.text = name;
                        this._operatorItem.actor.show();
                    } else
                        this._operatorItem.actor.hide();
                }
            }));
            this._signalQualityId = this.mobileDevice.connect('notify::signal-quality', Lang.bind(this, function() {
                if (this._operatorItem) {
                    this._operatorItem.setIcon(this._getSignalIcon());
                }
            }));
        }

        NMDevice.prototype._init.call(this, client, device, connections);
    },

    setEnabled: function(enabled) {
        this._enabled = enabled;
        if (this.category == NMConnectionCategory.WWAN) {
            if (enabled) {
                // prevent "network unavailable" statuses
                this.statusItem.setStatus(null);
            } else
                this.statusItem.setStatus(this.statusLabel);
        }

        NMDevice.prototype.setEnabled.call(this, enabled);
    },

    get connected() {
        return this._enabled && this.device.state == NM.DeviceState.ACTIVATED;
    },

    destroy: function() {
        if (this._operatorNameId) {
            this.mobileDevice.disconnect(this._operatorNameId);
            this._operatorNameId = 0;
        }
        if (this._signalQualityId) {
            this.mobileDevice.disconnect(this._signalQualityId);
            this._signalQualityId = 0;
        }

        NMDevice.prototype.destroy.call(this);
    },

    _getSignalIcon: function() {
        return 'xsi-network-cellular-signal-' + signalToIcon(this.mobileDevice.signal_quality);
    },

    _createSection: function() {
        if (!this._shouldShowConnectionList())
            return;

        if (this.mobileDevice) {
            // If operator_name is null, just pass the empty string, as the item is hidden anyway
            this._operatorItem = new PopupMenu.PopupImageMenuItem(this.mobileDevice.operator_name || '',
                                                                  this._getSignalIcon(),
                                                                  { reactive: false });
            if (!this.mobileDevice.operator_name)
                this._operatorItem.actor.hide();
            this.section.addMenuItem(this._operatorItem);
            this._operatorItem.actor.add_style_class_name('popup-device-menu-item');
        }

        NMDevice.prototype._createSection.call(this);
    },

    _clearSection: function() {
        this._operatorItem = null;

        NMDevice.prototype._clearSection.call(this);
    },

    _createAutomaticConnection: function() {
        // Mobile wizard is too complex for Cinnamon UI and
        // is handled by the network panel
        Util.spawn(['cinnamon-settings', 'network']);
        return null;
    }
};

function NMDeviceBluetooth() {
    this._init.apply(this, arguments);
}

NMDeviceBluetooth.prototype = {
    __proto__: NMDevice.prototype,

    _init: function(client, device, connections) {
        this._autoConnectionName = this._makeConnectionName(device);
        device.connect('notify::name', Lang.bind(this, this._updateAutoConnectionName));

        this.category = NMConnectionCategory.WWAN;

        NMDevice.prototype._init.call(this, client, device, connections);
    },

    _createAutomaticConnection: function() {
        let connection = new NM.SimpleConnection();
        connection._uuid = NM.utils_uuid_generate();
        connection.add_setting(new NM.SettingBluetooth());
        connection.add_setting(new NM.SettingConnection({
            uuid: connection._uuid,
            id: this._autoConnectionName,
            type: NM.SETTING_BLUETOOTH_SETTING_NAME,
            autoconnect: false
        }));
        return connection;
    },

    _makeConnectionName: function(device) {
        let name = device.name;
        if (name)
            return _("Auto %s").format(name);
        else
            return _("Auto bluetooth");
    },

    _updateAutoConnectionName: function() {
        this._autoConnectionName = this._makeConnectionName(this.device);

        this._clearSection();
        this._createSection();
    }
};


// Not a real device, but I save a lot code this way
function NMDeviceVPN() {
    this._init.apply(this, arguments);
}

NMDeviceVPN.prototype = {
    __proto__: NMDevice.prototype,

    _init: function(client) {
        this._client = client
        this._autoConnectionName = null;
        this.category = NMConnectionCategory.VPN;

        this._activeConnections = [];

        NMDevice.prototype._init.call(this, client, null, []);
    },

    connectionValid: function(connection) {
        return connection._type == NM.SETTING_VPN_SETTING_NAME ||
               connection._type == NM.SETTING_WIREGUARD_SETTING_NAME;
    },

    _kindLabel: function(connection) {
        if (connection._type == NM.SETTING_WIREGUARD_SETTING_NAME)
            return _("WireGuard");

        let vpn = connection.get_setting_vpn();
        let service = vpn ? vpn.get_service_type() : null;
        if (!service)
            return null;

        let plugin = service.split('.').pop();
        return VPN_KIND_NAMES.hasOwnProperty(plugin) ? VPN_KIND_NAMES[plugin] : plugin;
    },

    get empty() {
        return this._connections.length == 0;
    },

    setActiveConnections: function(activeConnections) {
        this._activeConnections = activeConnections || [];
        this._createSection();
    },

    _clearSection: function() {
        if (this.section && this.section.removeAll) {
            keepFocusInSection(this.section);
            this.section.removeAll();
        }

        this._autoConnectionItem = null;
        this._overflowItem = null;

        for (let i = 0; i < this._connections.length; i++)
            this._connections[i].item = null;
    },

    _updateConnectionItemView: function(item, connection, active) {
        item.label.text = connection._name  || _("Connected (private)");
        item.setStatus(this._kindLabel(connection));
        item.setToggleState(active);
        setSwitchMark(item, PRIMARY_CONNECTION != null &&
                            PRIMARY_CONNECTION.connection === connection);
    },

    removeConnection: function(connection) {
        let pos = this._findConnection(connection._uuid);
        if (pos == -1)
            return;

        this._clearSection();
        this._connections.splice(pos, 1);
        this._createSection();
    },

    /* A switch per tunnel: VPN and WireGuard connections are independent of
       one another, so they are not a pick-one list. */
    _createConnectionItem: function(obj) {
        let item = new PopupMenu.PopupSwitchMenuItem(obj.name, false);
        item.connect('toggled', (item, state) => {
            let activeConnection = this._activeConnections.find(ac => ac.connection === obj.connection);

            if (!state && activeConnection)
                this._client.deactivate_connection(activeConnection, null);
            else if (state && !activeConnection)
                this._client.activate_connection_async(obj.connection, this.device, null, null, null);
        });
        return item;
    },

    /* Building can re-enter: when the menu is open and one of the rows holds
       the key focus (the pointer is over it), _clearSection() destroys that
       row, the menu loses its focus and closes, and closing it runs
       _updateIcon(), which calls back in here.  The inner build then filled
       the cleared section, the outer build nulled its rows' owners and added
       its own after them, and every tunnel was listed twice.  So a call made
       during a build only marks the section stale; it is built again once
       the running build is done. */
    _createSection: function() {
        if (this._buildingSection) {
            this._sectionStale = true;
            return;
        }

        this._buildingSection = true;
        try {
            // at most a few passes: each one only repeats a request made during the last
            for (let pass = 0; pass < 3; pass++) {
                this._sectionStale = false;
                this._buildSection();
                if (!this._sectionStale)
                    break;
            }
        } finally {
            this._buildingSection = false;
        }
    },

    _buildSection: function() {
        let active = [];
        let inactive = [];
        for (let obj of this._connections) {
            if (this._activeConnections.some(ac => ac.connection == obj.connection))
                active.push(obj);
            else
                inactive.push(obj);
        }
        let ordered = active.concat(inactive);

        let shown = this._shownConnections;
        let layoutChanged = !shown || shown.length != ordered.length ||
                            ordered.some((obj, i) => obj !== shown[i] || !obj.item);

        if (layoutChanged) {
            this._clearSection();

            for (let i = 0; i < ordered.length; i++) {
                ordered[i].item = this._createConnectionItem(ordered[i]);
                this._addConnectionItem(ordered[i].item, i);
            }

            this._shownConnections = ordered;
        }

        for (let i = 0; i < ordered.length; i++)
            this._updateConnectionItemView(ordered[i].item, ordered[i].connection, i < active.length);
    },
};


function NMDeviceWireless() {
    this._init.apply(this, arguments);
}

NMDeviceWireless.prototype = {
    __proto__: NMDevice.prototype,

    _init: function(client, device, connections) {
        this.category = NMConnectionCategory.WIRELESS;

        this._overflowItem = null;
        this._networks = [ ];

        this._client = client;

        // breaking the layers with this, but cannot call
        // this.connectionValid until I have a device
        this.device = device;

        let validConnections = connections.filter(Lang.bind(this, function(connection) {
            return this.connectionValid(connection);
        }));
        let accessPoints = device.get_access_points() || [ ];
        for (let i = 0; i < accessPoints.length; i++) {
            // Access points are grouped by network
            let ap = accessPoints[i];

            if (ap.get_ssid() == null) {
                // hidden access point cannot be added, we need to know
                // the SSID and security details to connect
                // nevertheless, the access point can acquire a SSID when
                // NetworkManager connects to it (via nmcli or cinnamon-settings)
                ap._notifySsidId = ap.connect('notify::ssid', Lang.bind(this, this._notifySsidCb));
                continue;
            }

            let pos = this._findNetwork(ap);
            let obj;
            if (pos != -1) {
                obj = this._networks[pos];
                obj.accessPoints.push(ap);
            } else {
                obj = { ssid: ap.get_ssid(),
                        mode: ap.mode,
                        security: this._getApSecurityType(ap),
                        connections: [ ],
                        item: null,
                        accessPoints: [ ap ]
                      };
                obj.ssidText = ssidToLabel(obj.ssid);
                this._networks.push(obj);
            }

            // Check if some connection is valid for this AP
            for (let j = 0; j < validConnections.length; j++) {
                let connection = validConnections[j];
                if (ap.connection_valid(connection) &&
                    obj.connections.indexOf(connection) == -1) {
                    obj.connections.push(connection);
                }
            }
        }

        if (this.device.active_access_point) {
            let networkPos = this._findNetwork(this.device.active_access_point);

            if (networkPos == -1) // the connected access point is invisible
                this._activeNetwork = null;
            else
                this._activeNetwork = this._networks[networkPos];
        } else {
            this._activeNetwork = null;
        }
        this._networks.sort(this._networkSortFunction);

        this._apChangedId = device.connect('notify::active-access-point', Lang.bind(this, this._activeApChanged));
        this._apAddedId = device.connect('access-point-added', Lang.bind(this, this._accessPointAdded));
        this._apRemovedId = device.connect('access-point-removed', Lang.bind(this, this._accessPointRemoved));

        NMDevice.prototype._init.call(this, client, device, validConnections);
    },

    destroy: function() {
        if (this._apChangedId) {
            // see above for this HACK
            GObject.Object.prototype.disconnect.call(this.device, this._apChangedId);
            this._apChangedId = 0;
        }

        if (this._apAddedId) {
            GObject.Object.prototype.disconnect.call(this.device, this._apAddedId);
            this._apAddedId = 0;
        }

        if (this._apRemovedId) {
            GObject.Object.prototype.disconnect.call(this.device, this._apRemovedId);
            this._apRemovedId = 0;
        }

        NMDevice.prototype.destroy.call(this);
    },

    setEnabled: function(enabled) {
        if (enabled) {
            this.statusItem.actor.show();
            this.section.actor.show();
        } else {
            this.statusItem.actor.hide();
            this.section.actor.hide();
        }
    },

    activate: function() {
        if (this._activeConnection)
            // nothing to do
            return;

        // among all visible networks, pick the last recently used connection
        let best = null;
        let bestApObj = null;
        let bestTime = 0;
        for (let i = 0; i < this._networks.length; i++) {
            let apObj = this._networks[i];
            for (let j = 0; j < apObj.connections.length; j++) {
                let connection = apObj.connections[j];
                if (connection._timestamp > bestTime) {
                    best = connection;
                    bestTime = connection._timestamp;
                    bestApObj = apObj;
                }
            }
        }

        if (best) {
            for (let i = 0; i < bestApObj.accessPoints.length; i++) {
                let ap = bestApObj.accessPoints[i];
                if (ap.connection_valid(best)) {
                    this._client.activate_connection_async(best, this.device, ap.path, null, null);
                    break;
                }
            }
            return;
        }

        // XXX: what else to do?
        // for now, just pick a random network
        // (this function is called in a corner case anyway, that is, only when
        // the user toggles the switch and has more than one wireless device)
        if (this._networks.length > 0) {
            let connection = this._createAutomaticConnection(this._networks[0]);
            let accessPoints = sortAccessPoints(this._networks[0].accessPoints);
            this._client.add_and_activate_connection_async(connection, this.device, accessPoints[0].path, null, null);
        }
    },

    _notifySsidCb: function(accessPoint) {
        if (accessPoint.get_ssid() != null) {
            accessPoint.disconnect(accessPoint._notifySsidId);
            accessPoint._notifySsidId = 0;
            this._accessPointAdded(this.device, accessPoint);
        }
    },

    _activeApChanged: function() {
        this._activeNetwork = null;

        let activeAp = this.device.active_access_point;

        if (activeAp) {
            let res = this._findExistingNetwork(activeAp);

            if (res != null)
                this._activeNetwork = this._networks[res.network];
        }

        // we don't refresh the view here, setActiveConnection will
    },

    _getApSecurityType: function(accessPoint) {
        if (accessPoint._secType)
            return accessPoint._secType;

        let flags = accessPoint.flags;
        let wpa_flags = accessPoint.wpa_flags;
        let rsn_flags = accessPoint.rsn_flags;
        let type;
        if (rsn_flags != NM80211ApSecurityFlags.NONE) {
            /* RSN check first so that WPA+WPA2 APs are treated as RSN/WPA2 */
            if (rsn_flags & NM80211ApSecurityFlags.KEY_MGMT_802_1X)
                type = NMAccessPointSecurity.WPA2_ENT;
            else if (rsn_flags & NM80211ApSecurityFlags.KEY_MGMT_PSK)
                type = NMAccessPointSecurity.WPA2_PSK;
            else if (rsn_flags & NM80211ApSecurityFlags.KEY_MGMT_SAE)
                type = NMAccessPointSecurity.SAE;
            else if (rsn_flags & (NM80211ApSecurityFlags.KEY_MGMT_OWE |
                                  NM80211ApSecurityFlags.KEY_MGMT_OWE_TM))
                type = NMAccessPointSecurity.OWE;
        } else if (wpa_flags != NM80211ApSecurityFlags.NONE) {
            if (wpa_flags & NM80211ApSecurityFlags.KEY_MGMT_802_1X)
                type = NMAccessPointSecurity.WPA_ENT;
            else if (wpa_flags & NM80211ApSecurityFlags.KEY_MGMT_PSK)
                type = NMAccessPointSecurity.WPA_PSK;
        } else {
            if (flags & NM80211ApFlags.PRIVACY)
                type = NMAccessPointSecurity.WEP;
            else
                type = NMAccessPointSecurity.NONE;
        }

        // cache the found value to avoid checking flags all the time
        accessPoint._secType = type;
        return type;
    },

    _networkSortFunction: function(one, two) {
        let oneHasConnection = one.connections.length != 0;
        let twoHasConnection = two.connections.length != 0;
        // place known connections first
        // (-1 = good order, 1 = wrong order)
        if (oneHasConnection && !twoHasConnection)
            return -1;
        else if (!oneHasConnection && twoHasConnection)
            return 1;

        return two.accessPoints[0].strength - one.accessPoints[0].strength;
/**
        let oneHasSecurity = one.security != NMAccessPointSecurity.NONE;
        let twoHasSecurity = two.security != NMAccessPointSecurity.NONE;

        // place secure connections first
        // (we treat WEP/WPA/WPA2 the same as there is no way to
        // take them apart from the UI)
        if (oneHasSecurity && !twoHasSecurity)
            return -1;
        else if (!oneHasSecurity && twoHasSecurity)
            return 1;

        // sort alphabetically
        return GLib.utf8_collate(one.ssidText, two.ssidText);
**/
    },

    _networkCompare: function(network, accessPoint) {
        if (!network.ssid.equal (accessPoint.get_ssid()))
            return false;
        if (network.mode != accessPoint.mode)
            return false;
        if (network.security != this._getApSecurityType(accessPoint))
            return false;

        return true;
    },

    _findExistingNetwork: function(accessPoint) {
        for (let i = 0; i < this._networks.length; i++) {
            let apObj = this._networks[i];
            for (let j = 0; j < apObj.accessPoints.length; j++) {
                if (apObj.accessPoints[j] == accessPoint)
                    return { network: i, ap: j };
            }
        }

        return null;
    },

    _findNetwork: function(accessPoint) {
        if (accessPoint.get_ssid() == null)
            return -1;

        for (let i = 0; i < this._networks.length; i++) {
            if (this._networkCompare(this._networks[i], accessPoint))
                return i;
        }
        return -1;
    },

    _updateItemAccessPoints: function(apObj) {
        // with 2+ saved connections the item is a submenu, one row per connection
        if (apObj.item instanceof PopupMenu.PopupSubMenuMenuItem) {
            for (let item of apObj.item.menu._getMenuItems())
                item.updateAccessPoints(apObj.accessPoints);
        } else {
            apObj.item.updateAccessPoints(apObj.accessPoints);
        }
    },

    _accessPointAdded: function(device, accessPoint) {
        if (accessPoint.get_ssid() == null) {
            // This access point is not visible yet
            // Wait for it to get a ssid
            accessPoint._notifySsidId = accessPoint.connect('notify::ssid', Lang.bind(this, this._notifySsidCb));
            return;
        }

        let pos = this._findNetwork(accessPoint);
        let apObj;
        let needsupdate = false;

        if (pos != -1) {
            apObj = this._networks[pos];
            if (apObj.accessPoints.indexOf(accessPoint) != -1) {
                log('Access point was already seen, not adding again');
                return;
            }

            apObj.accessPoints.push(accessPoint);
            if (apObj.item)
                this._updateItemAccessPoints(apObj);
        } else {
            apObj = { ssid: accessPoint.get_ssid(),
                      mode: accessPoint.mode,
                      security: this._getApSecurityType(accessPoint),
                      connections: [ ],
                      item: null,
                      accessPoints: [ accessPoint ]
                    };
            apObj.ssidText = ssidToLabel(apObj.ssid);
            needsupdate = true;
        }

        // check if this enables new connections for this group
        for (let i = 0; i < this._connections.length; i++) {
            let connection = this._connections[i].connection;
            if (accessPoint.connection_valid(connection) &&
                apObj.connections.indexOf(connection) == -1) {
                apObj.connections.push(connection);

                // this potentially changes the order
                needsupdate = true;
            }
        }

        if (needsupdate) {
            if (pos != -1) {
                // rebuild, as addConnection() does
                this._networks.sort(this._networkSortFunction);
                this._clearSection();
                this._createSection();
                return;
            }

            if (this._networks.length == 0) {
                // only network in the list
                this._networks.push(apObj);
                this._clearSection();
                this._createSection();
                return;
            }

            // skip networks that should appear earlier
            let menuPos = this._activeConnectionItem ? 1 : 0;
            for (pos = 0;
                 pos < this._networks.length &&
                 this._networkSortFunction(this._networks[pos], apObj) < 0; ++pos) {
                if (this._networks[pos] != this._activeNetwork)
                    menuPos++;
            }

            // (re-)add the network
            this._networks.splice(pos, 0, apObj);

            if (this._shouldShowConnectionList()) {
                this._createNetworkItem(apObj, menuPos);
                if (menuPos < NUM_VISIBLE_NETWORKS && this._networks.length > NUM_VISIBLE_NETWORKS) {
                    for (; menuPos < NUM_VISIBLE_NETWORKS; ++pos) {
                        if (this._networks[pos] != this._activeNetwork)
                            menuPos++;
                    }
                    // pos is past the end when the active network has no row of its own
                    // (no active connection): then no row was pushed out
                    let item = pos < this._networks.length ? this._networks[pos].item : null;
                    if (item && item._apObj) {
                        item.destroy();
                        item._apObj.item = null;

                        this._createNetworkItem(item._apObj, NUM_VISIBLE_NETWORKS);
                    }
                }
            }
        }
    },

    _accessPointRemoved: function(device, accessPoint) {
        let res = this._findExistingNetwork(accessPoint);

        if (res == null) {
            return;
        }

        let apObj = this._networks[res.network];
        apObj.accessPoints.splice(res.ap, 1);

        if (apObj.accessPoints.length == 0) {
            if (this._activeNetwork == apObj)
                this._activeNetwork = null;

            if (apObj.item)
                apObj.item.destroy();

            if (this._overflowItem) {
                if (!apObj.isMore) {
                    // we removed an item in the main menu, and we have a more submenu
                    // we need to extract the first item in more and move it to the submenu

                    let item = this._overflowItem.menu.firstMenuItem;
                    if (item && item._apObj) {
                        item.destroy();
                        // clear the cycle, and allow the construction of the new item
                        item._apObj.item = null;

                        this._createNetworkItem(item._apObj, NUM_VISIBLE_NETWORKS-1);
                    } else {
                        log('The more... menu was existing and empty! This should not happen');
                    }
                }

                // This can happen if the removed connection is from the overflow
                // menu, or if we just moved the last connection out from the menu
                if (this._overflowItem.menu.numMenuItems == 0) {
                    this._overflowItem.destroy();
                    this._overflowItem = null;
                }
            }
            this._networks.splice(res.network, 1);

        } else if (apObj.item)
            this._updateItemAccessPoints(apObj);
    },

    _createAPItem: function(connection, accessPointObj, useConnectionName) {
        let item = new NMNetworkMenuItem(accessPointObj.accessPoints, useConnectionName ? connection._name : accessPointObj.ssidText);
        item._connection = connection;
        item.connect('activate', Lang.bind(this, function() {
            let accessPoints = sortAccessPoints(accessPointObj.accessPoints);
            for (let i = 0; i < accessPoints.length; i++) {
                if (accessPoints[i].connection_valid(connection)) {
                    this._client.activate_connection_async(connection, this.device, accessPoints[i].path, null, null);
                    break;
                }
            }
        }));
        return item;
    },

    _clearSection: function() {
        NMDevice.prototype._clearSection.call(this);

        for (let i = 0; i < this._networks.length; i++)
            this._networks[i].item = null;
        this._overflowItem = null;
    },

    removeConnection: function(connection) {
        if (!connection._uuid)
            return;
        let pos = this._findConnection(connection._uuid);
        if (pos == -1) {
            // removing connection that was never added
            return;
        }

        this._connections.splice(pos, 1);

        let anyauto = false, forceupdate = false;
        for (let i = 0; i < this._networks.length; i++) {
            let apObj = this._networks[i];
            let connections = apObj.connections;
            for (let k = 0; k < connections.length; k++) {
                if (connections[k]._uuid == connection._uuid) {
                    // remove the connection from the access point group
                    connections.splice(k, 1);
                    anyauto = connections.length == 0;

                    if (anyauto) {
                        // this potentially changes the sorting order
                        forceupdate = true;
                        break;
                    }
                    if (apObj.item) {
                        if (apObj.item instanceof PopupMenu.PopupSubMenuMenuItem) {
                            let items = apObj.item.menu._getMenuItems();
                            if (items.length == 2) {
                                // we need to update the connection list to convert this to a normal item
                                forceupdate = true;
                            } else {
                                for (let j = 0; j < items.length; j++) {
                                    if (items[j]._connection._uuid == connection._uuid) {
                                        items[j].destroy();
                                        break;
                                    }
                                }
                            }
                        } else {
                            apObj.item.destroy();
                            apObj.item = null;
                        }
                    }
                    break;
                }
            }
        }

        if (forceupdate || anyauto) {
            this._networks.sort(this._networkSortFunction);
            this._clearSection();
            this._createSection();
        }
    },

    addConnection: function(connection) {
        // record the connection
        let obj = {
            connection: connection,
            name: connection._name,
            uuid: connection._uuid,
        };
        this._connections.push(obj);

        // find an appropriate access point
        let forceupdate = false;
        for (let i = 0; i < this._networks.length; i++) {
            let apObj = this._networks[i];

            // Check if connection is valid for any of these access points
            for (let k = 0; k < apObj.accessPoints.length; k++) {
                let ap = apObj.accessPoints[k];
                if (ap.connection_valid(connection)) {
                    apObj.connections.push(connection);
                    // this potentially changes the sorting order
                    forceupdate = true;
                    break;
                }
            }
        }

        if (forceupdate) {
            this._networks.sort(this._networkSortFunction);
            this._clearSection();
            this._createSection();
        }
    },

    _createActiveConnectionItem: function() {
        if (this._activeConnection.connection) {
            if (!this._activeNetwork) {
                if (this.device.active_access_point) {
                    let networkPos = this._findNetwork(this.device.active_access_point);
                    if (networkPos == -1) // the connected access point is invisible
                        this._activeNetwork = null;
                    else
                        this._activeNetwork = this._networks[networkPos];
                } else {
                    this._activeNetwork = null;
                }
            }

            if (this._activeNetwork)
                this._activeConnectionItem = new NMNetworkMenuItem(this._activeNetwork.accessPoints, this._activeNetwork.ssidText, { reactive: false });
            else
                this._activeConnectionItem = new PopupMenu.PopupImageMenuItem(this._activeConnection.connection._name, 'xsi-network-wireless-connected', { reactive: false });
        } else {
            // We cannot read the connection (due to ACL, or API incompatibility), but we still show signal if we have it
            if (this._activeNetwork)
                this._activeConnectionItem = new NMNetworkMenuItem(this._activeNetwork.accessPoints, this._activeNetwork.ssidText,
                                                                   { reactive: false });
            else
                this._activeConnectionItem = new PopupMenu.PopupImageMenuItem(_("Connected (private)"),
                                                                              'xsi-network-wireless-connected',
                                                                              { reactive: false });
        }
        this._activeConnectionItem.setShowDot(true);
        this._activeConnectionItem.actor.add_style_class_name('popup-device-menu-item');
        if (this._activeConnectionItem.setActiveAp)
            this._activeConnectionItem.setActiveAp(this.device.active_access_point);

        /* '.popup-device-menu-item' is added a line above, AFTER the item was
           built, and it sets font-weight: bold.  The icon box has by then cached
           a preferred width computed from the pre-bold metrics, so on first
           layout it is allocated ~8px wider than its children need; St packs
           them from the left and the signal icon ends up short of the right
           edge that every other row lines up on.  It self-corrects on the next
           relayout, which is what made it look intermittent.  queue_relayout()
           drops the cached size so the FIRST allocation is already right.
           A PopupImageMenuItem (network not in the scan list) has no icon box. */
        this._activeConnectionItem.actor.queue_relayout();
        if (this._activeConnectionItem._icons)
            this._activeConnectionItem._icons.queue_relayout();
    },

    _createAutomaticConnection: function(apObj) {
        let name;
        let ssid = NM.utils_ssid_to_utf8(apObj.ssid.get_data());
        if (ssid) {
            /* Translators: this the automatic wireless connection name (including the network name) */
            name = _("Auto %s").format(ssid);
        } else
            name = _("Auto wireless");

        let connection = new NM.SimpleConnection();
        connection.add_setting(new NM.SettingWireless());
        let setting_conn = new NM.SettingConnection({
            id: name,
            autoconnect: true, // NetworkManager will know to ignore this if appropriate
            uuid: NM.utils_uuid_generate(),
            type: NM.SETTING_WIRELESS_SETTING_NAME
        });
        if (default_to_private_connections(this._client)) {
            setting_conn.add_permission('user', GLib.get_user_name(), null);
            if (apObj.security == NMAccessPointSecurity.WPA2_PSK ||
                apObj.security == NMAccessPointSecurity.WPA_PSK ||
                apObj.security == NMAccessPointSecurity.SAE) {
                connection.add_setting(new NM.SettingWirelessSecurity({
                    psk_flags: NM.SettingSecretFlags.AGENT_OWNED
                }));
            }
            if (apObj.security == NMAccessPointSecurity.WEP) {
                connection.add_setting(new NM.SettingWirelessSecurity({
                    wep_key_flags: NM.SettingSecretFlags.AGENT_OWNED
                }));
            }
        }
        connection.add_setting(setting_conn);
        return connection;
    },

    _createNetworkItem: function(apObj, position) {

        if(!apObj.accessPoints || apObj.accessPoints.length == 0) {
            // this should not happen, but I have no idea why it happens
            return;
        }

        if(apObj.connections.length > 0) {
            if (apObj.connections.length == 1) {
                apObj.item = this._createAPItem(apObj.connections[0], apObj, false);
            } else {
                let title = apObj.ssidText;
                apObj.item = new PopupMenu.PopupSubMenuMenuItem(title);
                for (let i = 0; i < apObj.connections.length; i++)
                    apObj.item.menu.addMenuItem(this._createAPItem(apObj.connections[i], apObj, true));
            }
        } else {
            apObj.item = new NMNetworkMenuItem(apObj.accessPoints, apObj.ssidText);
            apObj.item.connect('activate', Lang.bind(this, function() {
                let accessPoints = sortAccessPoints(apObj.accessPoints);
                if ((accessPoints[0]._secType == NMAccessPointSecurity.WPA2_ENT) ||
                    (accessPoints[0]._secType == NMAccessPointSecurity.WPA_ENT)) {
                    // 802.1x-enabled APs require further configuration, so they're
                    // handled in cinnamon-settings
                    Util.spawn(['cinnamon-settings', 'network']);
                } else {
                    let connection = this._createAutomaticConnection(apObj);
                    this._client.add_and_activate_connection_async(connection, this.device, accessPoints[0].path, null, null);
                }
            }));
        }
        apObj.item._apObj = apObj;

        if (position < NUM_VISIBLE_NETWORKS) {
            apObj.isMore = false;
            this.section.addMenuItem(apObj.item, position);
        } else {
            if (!this._overflowItem) {
                this._overflowItem = new PopupMenu.PopupSubMenuMenuItem(_("More"));
                this.section.addMenuItem(this._overflowItem);
            }
            this._overflowItem.menu.addMenuItem(apObj.item, position - NUM_VISIBLE_NETWORKS);
            apObj.isMore = true;
        }
    },

    _createSection: function() {
        if (!this._shouldShowConnectionList())
            return;

        if(this._activeConnection) {
            this._createActiveConnectionItem();
            this.section.addMenuItem(this._activeConnectionItem);
        }

        let activeOffset = this._activeConnectionItem ? 1 : 0;

        for(let j = 0; j < this._networks.length; j++) {
            let apObj = this._networks[j];
            if (apObj == this._activeNetwork) {
                activeOffset = 0; // we no longer need to account for this
                continue;
            }

            this._createNetworkItem(apObj, j + activeOffset);
        }
    },
};

function NMMessageTraySource() {
    this._init();
}

NMMessageTraySource.prototype = {
    __proto__: MessageTray.Source.prototype,

    _init: function() {
        MessageTray.Source.prototype._init.call(this, _("Network Manager"));

        let icon = new St.Icon({ icon_name: 'xsi-network-transmit-receive',
                                 icon_type: St.IconType.SYMBOLIC,
                                 icon_size: this.ICON_SIZE
                               });
        this._setSummaryIcon(icon);
    }
};

function CinnamonNetworkApplet(metadata, orientation, panel_height, instance_id) {
    this._init(metadata, orientation, panel_height, instance_id);
}

CinnamonNetworkApplet.prototype = {
    __proto__: Applet.TextIconApplet.prototype,

    _init: function(metadata, orientation, panel_height, instance_id) {
        Applet.TextIconApplet.prototype._init.call(this, orientation, panel_height, instance_id);

        try {
            this.metadata = metadata;
            Main.systrayManager.registerTrayIconReplacement("network", metadata.uuid);
            Main.systrayManager.registerTrayIconReplacement("nm-applet", metadata.uuid);

            this.menuManager = new PopupMenu.PopupMenuManager(this);
            this.menu = new Applet.AppletPopupMenu(this, orientation);
            this.menuManager.addMenu(this.menu);

            this._currentIconName = undefined;
            this._setIcon('xsi-network-offline');

            /* One panel icon per kind of link, always in LINK_ICON_KINDS
               order, each shown only while a connection of that kind is up
               (see _drawLinkIcons()).  The applet's own icon stays as the
               fallback for when none of them is.  A tunnel has an icon of
               its own rather than a padlock on the bars: the padlock means
               "this Wi-Fi network is encrypted", as it does in the menu. */
            this._linkIcons = { };
            for (let kind of LINK_ICON_KINDS)
                this._linkIcons[kind] = this._makeLinkIcon(kind);
            this._primaryConnection = null;

            // the primary line takes the panel's text colour: follow theme changes
            this.actor.connect('style-changed', () => {
                for (let kind in this._linkIcons) {
                    if (this._linkIcons[kind].primaryLine)
                        this._setPrimaryLine(this._linkIcons[kind], true);
                }
            });

            this.settings = new Settings.AppletSettings(this, metadata.uuid, this.instance_id);
            this.settings.bind("keyOpen", "keyOpen", this._setKeybinding);
            this.settings.bind("showBand", "showBand", this._onRowOptsChanged);
            this.settings.bind("showChannelWidth", "showChannelWidth", this._onRowOptsChanged);
            this.settings.bind("showSecurity", "showSecurity", this._onRowOptsChanged);
            this.settings.bind("showSignalPercent", "showSignalPercent", this._onRowOptsChanged);
            this._syncRowOpts();
            this._setKeybinding();

            NM.Client.new_async(null, Lang.bind(this, this._clientGot));
        }
        catch (e) {
            global.logError(e);
        }
    },

    _setKeybinding() {
        Main.keybindingManager.addXletHotKey(this, "network-open", this.keyOpen, Lang.bind(this, this._openMenu));
    },

    _clientGot: function(obj, result) {
        try {
            this._client = NM.Client.new_finish(result);
            this._v1_28_0 = Util.version_exceeds(this._client.get_version(), "1.28.0");

            this._nm_proxy = null;

            if (!this._v1_28_0) {
                new NMDBus(Lang.bind(this, function(proxy, error) {
                    this._nm_proxy = proxy;
                }));
            }

            this._statusSection = new PopupMenu.PopupMenuSection();
            this._statusItem = new PopupMenu.PopupMenuItem('', { style_class: 'popup-inactive-menu-item', reactive: false });
            this._statusSection.addMenuItem(this._statusItem);
            this._statusSection.addAction(_("Enable networking"), Lang.bind(this, function() {
                this._client.networking_enabled = true;
            }));
            this._statusSection.actor.hide();
            this.menu.addMenuItem(this._statusSection);
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            this._devices = { };

            this._devices.wired = {
                section: new PopupMenu.PopupMenuSection(),
                devices: [ ],
                item: new NMWiredSectionTitleMenuItem(_("Wired"))
            };

            this._devices.wired.section.addMenuItem(this._devices.wired.item);
            this._devices.wired.section.actor.hide();
            this.menu.addMenuItem(this._devices.wired.section);
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            this._devices.wireless = {
                section: new PopupMenu.PopupMenuSection(),
                devices: [ ],
                item: this._makeToggleItem('wireless', _("Wireless"))
            };
            this._devices.wireless.section.addMenuItem(this._devices.wireless.item);
            this._devices.wireless.section.actor.hide();
            this.menu.addMenuItem(this._devices.wireless.section);
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            this._devices.wwan = {
                section: new PopupMenu.PopupMenuSection(),
                devices: [ ],
                item: this._makeToggleItem('wwan', _("Mobile broadband"))
            };
            this._devices.wwan.section.addMenuItem(this._devices.wwan.item);
            this._devices.wwan.section.actor.hide();
            this.menu.addMenuItem(this._devices.wwan.section);
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            this._devices.vpn = {
                section: new PopupMenu.PopupMenuSection(),
                device: new NMDeviceVPN(this._client),
                item: new PopupMenu.PopupMenuItem(_("VPN Connections"), { reactive: false, style_class: 'popup-subtitle-menu-item' })
            };
            this._devices.vpn.section.addMenuItem(this._devices.vpn.item);
            this._devices.vpn.section.addMenuItem(this._devices.vpn.device.section);
            this._devices.vpn.section.actor.hide();
            this.menu.addMenuItem(this._devices.vpn.section);
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            this.menu.addSettingsAction(_("Network Settings"), 'network');
            this.menu.addAction(_("Network Connections"), Lang.bind(this, function() {
                Util.spawnCommandLine("nm-connection-editor");
            }));

            this.menu.connect("open-state-changed", Lang.bind(this, this._onMenuOpenStateChanged));

            this._periodicTimeoutId = 0;
            this._updateFrequencySeconds = 0;
            this._checkingConnectivity = false;
            this._lastConnectivityState = NM.ConnectivityState.UNKNOWN;

            this._activeConnections = [ ];
            this._connections = [ ];

            this._mainConnection = null;

            // Device types
            this._dtypes = { };
            this._dtypes[NM.DeviceType.ETHERNET] = NMDeviceWired;
            this._dtypes[NM.DeviceType.WIFI] = NMDeviceWireless;
            this._dtypes[NM.DeviceType.MODEM] = NMDeviceModem;
            this._dtypes[NM.DeviceType.BT] = NMDeviceBluetooth;

            // Connection types
            this._ctypes = { };
            this._ctypes[NM.SETTING_WIRELESS_SETTING_NAME] = NMConnectionCategory.WIRELESS;
            this._ctypes[NM.SETTING_WIRED_SETTING_NAME] = NMConnectionCategory.WIRED;
            this._ctypes[NM.SETTING_PPPOE_SETTING_NAME] = NMConnectionCategory.WIRED;
            this._ctypes[NM.SETTING_PPP_SETTING_NAME] = NMConnectionCategory.WIRED;
            this._ctypes[NM.SETTING_BLUETOOTH_SETTING_NAME] = NMConnectionCategory.WWAN;
            this._ctypes[NM.SETTING_CDMA_SETTING_NAME] = NMConnectionCategory.WWAN;
            this._ctypes[NM.SETTING_GSM_SETTING_NAME] = NMConnectionCategory.WWAN;
            this._ctypes[NM.SETTING_VPN_SETTING_NAME] = NMConnectionCategory.VPN;
            this._ctypes[NM.SETTING_WIREGUARD_SETTING_NAME] = NMConnectionCategory.VPN;

            this._readConnections();
            this._readDevices();
            this._syncNMState();

            this._client.connect('notify::nm-running', Lang.bind(this, this._syncNMState));
            this._client.connect('notify::networking-enabled', Lang.bind(this, this._syncNMState));
            this._client.connect('notify::state', Lang.bind(this, this._syncNMState));
            this._client.connect('notify::active-connections', Lang.bind(this, this._updateIcon));
            this._client.connect('device-added', Lang.bind(this, this._deviceAdded));
            this._client.connect('device-removed', Lang.bind(this, this._deviceRemoved));
            this._client.connect('connection-added', Lang.bind(this, this._connectionAdded));
            this._client.connect('connection-removed', Lang.bind(this, this._connectionRemoved));

            this._inited = true;

            this._periodicUpdateIcon();

        }
        catch (e) {
            global.logError(e);
        }
    },

    _setIcon: function(name) {
        if (this._currentIconName !== name) {
            this.set_applet_icon_symbolic_name(name);
            this._currentIconName = name;
        }
    },

    /* The size the panel gives symbolic icons in this applet's zone, which is
       what IconApplet._setStyle() gives the link icon.  null until the applet
       is on a panel: appletManager sets this.panel after _init(). */
    _panelIconSize: function() {
        if (!this.panel)
            return null;
        return this.panel.getPanelZoneIconSize(this.locationLabel, St.IconType.SYMBOLIC);
    },

    /* Size our own panel icons like the applet's own icon.  An St.Icon with
       no size of its own takes the theme's .applet-icon size (22px in
       Mint-Y), while the panel draws symbolic icons at its zone size (16px
       by default), so the tunnel icon came out visibly larger than the link
       icon beside it. */
    _sizePanelIcons: function() {
        let size = this._panelIconSize();
        if (!size || !this._linkIcons)
            return;

        let horizontal = this._horizontalPanel();
        for (let kind in this._linkIcons) {
            let group = this._linkIcons[kind];
            let want = (kind === NMConnectionCategory.VPN) ? Math.round(size * VPN_ICON_SCALE) : size;
            if (group.icon.icon_size !== want)
                group.icon.set_icon_size(want);

            // the next applet is beside the icon only in a horizontal panel
            if (group.holder)
                this._fitPanelIcon(group, want - size, horizontal ? Math.round(want * VPN_ICON_TRIM) : 0);
        }
        this._spaceLinkIcons();
    },

    _horizontalPanel: function() {
        return this._orientation === St.Side.TOP || this._orientation === St.Side.BOTTOM;
    },

    /* Lay the bigger tunnel icon out at the width the other icons take, and
       draw it centred over that, overflowing into its own empty margins.  Laid
       out at its full width those margins widened the gaps on both sides: 8px
       to the Wi-Fi bars against 6px between the other icons, and 14px to the
       next applet against 12px after a lone Wi-Fi or wired icon (measured in
       the realm).  A width on the St.Icon itself squeezes the glyph instead,
       so the icon sits in a fixed-layout holder that is given the width.
       The holder is then narrowed by trim on each side (see VPN_ICON_TRIM);
       the group gets that back as left padding (see _spaceLinkIcons()), and
       the count as its own, so only the gap after the icon shrinks.  The
       primary line spans the holder, so it stays centred over the glyph. */
    _fitPanelIcon: function(group, extra, trim) {
        let natural = group.icon.get_preferred_width(-1)[1];
        if (natural <= 0)
            return;   // not styled yet: the next redraw fits it
        group.trim = trim;

        let style = 'width: ' + Math.round(natural - extra - 2 * trim) + 'px;';
        if (group.holder.get_style() !== style)
            group.holder.set_style(style);

        let x = -Math.round(extra / 2) - trim;
        if (group.icon.x !== x || group.icon.y !== 0)
            group.icon.set_position(x, 0);

        let countStyle = 'padding-left: ' + trim + 'px;';
        if (group.count.get_style() !== countStyle)
            group.count.set_style(countStyle);
    },

    /* The padding before each icon's group: the trim its icon gave up (see
       _fitPanelIcon()), and LINK_ICON_GAP before every shown icon but the
       first, when the icons sit side by side in a horizontal panel. */
    _spaceLinkIcons: function() {
        let lead = 0;
        for (let kind of LINK_ICON_KINDS) {
            let group = this._linkIcons[kind];
            if (!group)
                continue;
            let shown = group.box.visible;
            let style = 'spacing: 2px; padding-left: ' + (group.trim + (shown ? lead : 0)) + 'px;';
            if (group.box.get_style() !== style)
                group.box.set_style(style);
            if (shown && this._horizontalPanel())
                lead = LINK_ICON_GAP;
        }
    },

    /* A panel icon for one kind of link, with the count to its right.  Kept
       before the TextIconApplet label, so the panel reads
       [fallback][wired][Wi-Fi][VPN][label]. */
    _makeLinkIcon: function(kind) {
        let icon = new St.Icon({ icon_type: St.IconType.SYMBOLIC,
                                 style_class: 'system-status-icon' });
        // the bigger tunnel icon sits in a holder (see _fitPanelIcon())
        let holder = null;
        if (kind === NMConnectionCategory.VPN) {
            holder = new St.Widget({ layout_manager: new Clutter.FixedLayout() });
            holder.add_child(icon);
        }
        // holds the primary line (see _setPrimaryLine())
        let iconBin = new St.Bin({ child: holder || icon, style: primaryLineStyle(null) });
        let count = new St.Label({ style_class: 'applet-label' });
        let box = new St.BoxLayout({ style: 'spacing: 2px;' });
        box.add(iconBin, { y_align: St.Align.MIDDLE, y_fill: false });
        box.add(count, { y_align: St.Align.MIDDLE, y_fill: false });
        count.hide();
        box.hide();

        this.actor.add(box, { y_align: St.Align.MIDDLE, y_fill: false });
        try {
            this.actor.set_child_below_sibling(box, this._layoutBin);
        } catch (e) {
            // appended after the label instead; still usable
        }
        return { box: box, iconBin: iconBin, holder: holder, icon: icon, count: count, primaryLine: false,
                 trim: 0 };
    },

    /* The panel's text colour as CSS, for the primary line: St has no
       currentColor.  null while the applet is off the stage, where St would
       complain about reading a theme node. */
    _primaryLineColor: function() {
        if (!this.actor.get_stage())
            return null;
        let c = this.actor.get_theme_node().get_foreground_color();
        return 'rgba(' + c.red + ',' + c.green + ',' + c.blue + ',' + (c.alpha / 255).toFixed(2) + ')';
    },

    _setPrimaryLine: function(group, on) {
        let color = on ? this._primaryLineColor() : null;
        let style = primaryLineStyle(color);
        if (group.iconBin.get_style() !== style)
            group.iconBin.set_style(style);
        group.primaryLine = !!color;
    },

    _activeAccessPoint: function(activeConnection) {
        let dev = activeConnection._primaryDevice;
        return (dev && dev.device && dev.device.active_access_point) || null;
    },

    /* The wired, Wi-Fi and VPN icons and the tooltip.  Only connections NM
       has ACTIVATED count; a kind with none up but one activating shows its
       "acquiring" icon, with no count.  With two links of one kind up, the
       icon is drawn from the one NM prefers (see linkPreference()).  Mobile
       broadband and Bluetooth have no icon of their own: they show through
       the fallback icon, when none of the three kinds is up.  Returns
       { shown: number of icons shown, connecting: whether any is acquiring }. */
    _drawLinkIcons: function() {
        let lines = [];
        let shown = 0;
        let connecting = false;
        let watchAp = null;

        this._sizePanelIcons();

        let primary = primaryConnection(this._activeConnections);
        if (primary !== PRIMARY_CONNECTION) {
            PRIMARY_CONNECTION = primary;
            this._refreshPrimaryMarks();
        }
        this._primaryConnection = primary;

        // the tooltip stars the primary too, once it lists more than one
        let listed = this._activeConnections.filter(a =>
            LINK_ICON_KINDS.includes(a._section) &&
            (a.state === NM.ActiveConnectionState.ACTIVATED ||
             a.state === NM.ActiveConnectionState.ACTIVATING)).length;

        for (let kind of LINK_ICON_KINDS) {
            let group = this._linkIcons[kind];
            let all = this._activeConnections.filter(a => a._section === kind);
            let up = all.filter(a => a.state === NM.ActiveConnectionState.ACTIVATED);
            let acting = all.filter(a => a.state === NM.ActiveConnectionState.ACTIVATING);

            if (up.length == 0 && acting.length == 0) {
                group.box.hide();
                continue;
            }

            // the drawn connection first, then the others in NM's order
            let best = preferredLink(up);
            let ordered = best ? [ best ].concat(up.filter(a => a !== best)) : [];
            let names = ordered.map(a => {
                let ap = (kind === NMConnectionCategory.WIRELESS) ? this._activeAccessPoint(a) : null;
                let name = ap ? ssidToLabel(ap.get_ssid()) + " (" + ap.strength + "%)"
                              : activeConnectionName(a);
                return markPrimary(name, listed > 1 && a === primary);
            });
            for (let a of acting)
                names.push(activeConnectionName(a) + " (" + _("connecting...") + ")");

            let iconName;
            if (kind === NMConnectionCategory.WIRELESS) {
                let ap = best ? this._activeAccessPoint(best) : null;
                if (ap) {
                    iconName = 'xsi-network-wireless-signal-' + signalToIcon(ap.strength) +
                               apSecuritySuffix(best._primaryDevice, ap);
                    watchAp = ap;
                } else {
                    iconName = best ? 'xsi-network-wireless-connected' : 'xsi-network-wireless-acquiring';
                }
            } else if (kind === NMConnectionCategory.WIRED) {
                iconName = best ? 'xsi-network-wired' : 'xsi-network-wired-acquiring';
            } else {
                iconName = best ? 'xsi-network-vpn' : 'xsi-network-vpn-acquiring';
            }
            if (!best)
                connecting = true;

            group.icon.icon_name = iconName;
            group.count.set_text(up.length > 1 ? String(up.length) : "");
            group.count.visible = up.length > 1;
            group.box.show();
            shown++;

            lines.push(linkKindTitle(kind) + ": " + names.join(", "));
        }
        this._spaceLinkIcons();

        /* Draw a line over the icon of the connection that carries the
           default route, once two or more icons are up.  Under a full tunnel
           that is the VPN icon, so the panel also tells a full tunnel from a
           split one. */
        for (let kind of LINK_ICON_KINDS)
            this._setPrimaryLine(this._linkIcons[kind],
                                 shown >= 2 && primary !== null && primary._section === kind);

        this._applet_icon_box.visible = (shown == 0);
        if (shown)
            this.set_applet_tooltip(lines.join("\n"));

        /* Keep the TextIconApplet's own label hidden: it is empty, but while
           shown it still takes the applet box's spacing, which left a gap
           after the last icon.  An empty text hides it. */
        this.set_applet_label("");

        /* Keep the drawn bars honest between timer ticks. */
        this._watchSignal(watchAp);

        return { shown: shown, connecting: connecting };
    },

    _hideLinkIcons: function() {
        for (let kind in this._linkIcons)
            this._linkIcons[kind].box.hide();
        this._applet_icon_box.show();
        this._watchSignal(null);
    },

    /* PRIMARY_CONNECTION changed: move the menu's mark on every device row,
       on the section headings that stand in for a lone device, and on the
       VPN rows. */
    _refreshPrimaryMarks: function() {
        for (let category of [ NMConnectionCategory.WIRED,
                               NMConnectionCategory.WIRELESS,
                               NMConnectionCategory.WWAN ]) {
            for (let dev of this._devices[category].devices) {
                if (dev.statusItem)
                    setSwitchMark(dev.statusItem, dev.isPrimary);
            }
            this._syncSectionTitle(category);
        }

        // reuses the rows while the list is unchanged, refreshing them
        this._devices.vpn.device._createSection();
    },

    on_panel_icon_size_changed: function(size) {
        this._sizePanelIcons();
    },

    on_panel_height_changed: function() {
        this._sizePanelIcons();
    },

    /* Mirror the settings into the module-level ROW_OPTS the menu items read. */
    _syncRowOpts: function() {
        ROW_OPTS.band     = this.showBand;
        ROW_OPTS.width    = this.showChannelWidth;
        ROW_OPTS.security = this.showSecurity;
        ROW_OPTS.percent  = this.showSignalPercent;
    },

    _onRowOptsChanged: function() {
        this._syncRowOpts();

        // called from a settings change, long after _init, but be safe
        if (!this._devices || !this._devices.wireless)
            return;

        for (let dev of this._devices.wireless.devices) {
            dev._clearSection();
            dev._createSection();
        }
    },

    /* Remembers the physical-link tooltip so tunnel names can be appended. */
    _setTooltip: function(text) {
        this._baseTooltip = text;
        this.set_applet_tooltip(text);
    },

    /* The panel icon is otherwise refreshed only by the periodic timer, so the
       drawn bars can lag reality by up to 10s (2s with the menu open).  Watch
       the active AP's strength directly.

       Two things keep this cheap.  Only the ACTIVE access point is watched --
       measured on the laptop, notify::strength fired ~8/min on it with 35 APs
       visible, so watching them all would be ~280/min.  And a redraw only
       happens when the signal crosses one of signalToIcon()'s five buckets. */
    _watchSignal: function(ap) {
        if (this._watchedAp === ap)
            return;

        if (this._watchedAp && this._watchedApId) {
            try {
                this._watchedAp.disconnect(this._watchedApId);
            } catch (e) {
                // access point already gone
            }
        }

        this._watchedAp = ap || null;
        this._watchedApId = 0;
        this._watchedLevel = ap ? signalToIcon(ap.strength) : null;

        if (ap) {
            this._watchedApId = ap.connect('notify::strength', () => {
                let level = signalToIcon(this._watchedAp.strength);
                if (level !== this._watchedLevel) {
                    this._watchedLevel = level;
                    this._updateIcon();
                }
            });
        }
    },

    on_applet_clicked: function(event) {
        if (!this.menu.isOpen)
            this._forgetMenuSizes();
        this.menu.toggle();
    },

    _openMenu: function () {
        if (!this.menu.isOpen)
            this._forgetMenuSizes();
        this.menu.toggle();
    },

    /* Cinnamon's popup menu lines up its rows' columns and caches each row's
       size, but setColumnWidths() only stores the new widths: nothing tells
       Clutter to measure the rows again (popupMenu.js does that only for
       themes with a background image).  Rows that did not change since kept
       their size from an earlier, wider menu.  On the laptop a second Wi-Fi
       adapter's 61-character name left the menu 764px wide after the adapter
       was unplugged, where 487px was enough (2026-11-11).  Forget every
       cached size just before the menu opens, so it is sized and placed from
       fresh measurements. */
    _forgetMenuSizes: function() {
        let walk = actor => {
            actor.queue_relayout();
            for (let child of actor.get_children())
                walk(child);
        };
        walk(this.menu.box);
    },

    _ensureSource: function() {
        if (!this._source) {
            this._source = new NMMessageTraySource();
            this._source.connect('destroy', Lang.bind(this, function() {
                this._source = null;
            }));
            if (Main.messageTray) Main.messageTray.add(this._source);
        }
    },

    _makeToggleItem: function(type, title) {
        let item = new NMWirelessSectionTitleMenuItem(this._client, type, title);
        item.connect('enabled-changed', Lang.bind(this, function(item, enabled) {
            let devices = this._devices[type].devices;
            devices.forEach(function(dev) {
                dev.setEnabled(enabled);
            });
            this._syncSectionTitle(type);
        }));
        return item;
    },

    _syncSectionTitle: function(category) {
        let devices = this._devices[category].devices;
        let vis_devices = [];

        let item = this._devices[category].item;
        let section = this._devices[category].section;

        /* We don't want unmanaged entries to clutter the list, but we do need to
         * keep them around in case they become manageable and need to be made visible
         * later (some valid wifi hardware starts out initially unmanaged, for instance.)
         * We'll only count managed devices for evaluating what entries to display, and
         * when to show or hide section titles. */
        if (devices) {
            for (let i = 0; i < devices.length; i++) {
                if (devices[i].device.state == NM.DeviceState.UNMANAGED) {
                    continue;
                }

                vis_devices.push(devices[i]);
            }
        }

        if (vis_devices.length == 0) {
            section.actor.hide();
        } else {
            section.actor.show();
            if (vis_devices.length == 1) {
                devices.forEach(function(dev) {
                    dev.statusItem.actor.hide();
                });

                let dev = vis_devices[0];
                item.updateForDevice(dev);
            } else {
                devices.forEach(function(dev) {
                    dev.statusItem.actor.visible = (dev.device.state != NM.DeviceState.UNMANAGED);
                });
                // remove status text from the section title item
                item.updateForDevice(null);
            }
        }
    },

    _readDevices: function() {
        let devices = this._client.get_devices() || [ ];
        for (let i = 0; i < devices.length; ++i) {
            this._deviceAdded(this._client, devices[i]);
        }
    },

    _notifyForDevice: function(device, iconName, title, text, urgency) {
        if (device._notification)
            device._notification.destroy();

        /* must call after destroying previous notification,
           or this._source will be cleared */
        this._ensureSource();

        let icon = new St.Icon({ icon_name: iconName,
                                 icon_type: St.IconType.SYMBOLIC,
                                 icon_size: this._source.ICON_SIZE
                               });
        device._notification = new MessageTray.Notification(this._source, title, text,
                                                            { icon: icon });
        device._notification.setUrgency(urgency);
        device._notification.setTransient(true);
        device._notification.connect('destroy', function() {
            device._notification = null;
        });
        this._source.notify(device._notification);
    },

    _deviceAdded: function(client, device) {
        if (device._delegate) {
            // already seen, not adding again
            return;
        }
        let wrapperClass = this._dtypes[device.get_device_type()];
        if (wrapperClass) {
            let wrapper = new wrapperClass(this._client, device, this._connections);

            wrapper._activationFailedId = wrapper.connect('activation-failed', Lang.bind(this, function(device, reason) {
                // XXX: nm-applet has no special text depending on reason
                // but I'm not sure of this generic message
                this._notifyForDevice(device, 'network-error',
                                      _("Connection failed"),
                                      _("Activation of network connection failed"),
                                     MessageTray.Urgency.HIGH);
            }));
            wrapper._deviceStateChangedId = wrapper.connect('state-changed', Lang.bind(this, function(dev) {
                this._syncSectionTitle(dev.category);
            }));
            wrapper._destroyId = wrapper.connect('destroy', function(wrapper) {
                wrapper.disconnect(wrapper._activationFailedId);
                wrapper.disconnect(wrapper._deviceStateChangedId);
                wrapper.disconnect(wrapper._destroyId);
            });
            let section = this._devices[wrapper.category].section;
            let devices = this._devices[wrapper.category].devices;

            section.addMenuItem(wrapper.section, 1);
            section.addMenuItem(wrapper.statusItem, 1);
            devices.push(wrapper);

            this._syncSectionTitle(wrapper.category);
        }
    },

    _deviceRemoved: function(client, device) {
        if (!device._delegate) {
            return;
        }

        let wrapper = device._delegate;
        wrapper.destroy();

        // its active connection can outlive it (when NetworkManager stops, the
        // devices go first): don't let _syncActiveConnections() use it later
        for (let a of this._activeConnections) {
            if (a._primaryDevice == wrapper)
                a._primaryDevice = null;
        }

        let devices = this._devices[wrapper.category].devices;
        let pos = devices.indexOf(wrapper);
        devices.splice(pos, 1);

        this._syncSectionTitle(wrapper.category);
    },

    _syncActiveConnections: function() {
        let closedConnections = [];
        let newActiveConnections = this._client.get_active_connections() || [];

        for (let a of this._activeConnections) {
            if (!newActiveConnections.includes(a))
                closedConnections.push(a);
        }

        for (let active of closedConnections) {
            if (active._primaryDevice) {
                if (active._section == NMConnectionCategory.VPN)
                    this._devices.vpn.device.setActiveConnections([]);
                else
                    active._primaryDevice.setActiveConnection(null);

                active._primaryDevice = null;
            }

            if (active._inited) {
                active.disconnect(active._notifyStateId);
                active._inited = false;
            }
        }

        this._activeConnections = newActiveConnections;
        this._mainConnection = null;

        let activating = null;
        let activated = null;
        let default_ip4 = null;
        let default_ip6 = null;

        let vpnConnections = [];

        for (let a of this._activeConnections) {
            if (!a._inited) {
                a._notifyStateId = a.connect('notify::state', Lang.bind(this, this._notifyActivated));
                a._inited = true;
            }

            if (!a._type) {
                a._type = a.connection._type;
                a._section = this._ctypes[a._type];
                if (a._errorLogged) {
                    log('network applet: Found connection for active');
                    a._errorLogged = false;
                }
            }

            if (!a._section){
                // Do not take connections which section is undefined into account
                // For instance, in Mint 18, when the "vpn" is "activated", we sometimes see a "tun" act as the default ipv4 connection.
                continue;
            }

            if (a.state == NM.ActiveConnectionState.ACTIVATED) {
                if (!default_ip4) {
                    // We didn't find the default IPV4 device yet..
                    if (!default_ip6) {
                        // We didn't find the default IPV6 device either so consider this one.
                        activated = a;
                    }
                    else {
                        // We already found the default IPV6 device, so only use this one if it's the default IPV4 device
                        if (a['default']) {
                            activated = a;
                        }
                    }
                }
            }
            if (a.state == NM.ActiveConnectionState.ACTIVATING) {
                activating = a;
            }

            if (a['default']) {
                default_ip4 = a;
            }
            if (a.default6) {
                default_ip6 = a;
            }

            if (!a._primaryDevice) {
                if (a._section != NMConnectionCategory.VPN) {
                    // find a good device to be considered primary
                    a._primaryDevice = null;
                    let devices = a.get_devices() || [ ];
                    for (let j = 0; j < devices.length; j++) {
                        let d = devices[j];
                        if (d._delegate) {
                            a._primaryDevice = d._delegate;
                            break;
                        }
                    }
                } else {
                    a._primaryDevice = this._devices.vpn.device;
                }

                if (a.state == NM.ActiveConnectionState.ACTIVATED &&
                    a._primaryDevice && a._primaryDevice._notification) {
                        a._primaryDevice._notification.destroy();
                        a._primaryDevice._notification = null;
                }
            }

            if (a._primaryDevice) {
                if (a._section == NMConnectionCategory.VPN)
                    vpnConnections.push(a);
                else
                    a._primaryDevice.setActiveConnection(a);
            }
        }

        if (this._devices.vpn && this._devices.vpn.device)
            this._devices.vpn.device.setActiveConnections(vpnConnections);

        this._mainConnection = activated || activating || default_ip4 || default_ip6 || null;
    },

    _notifyActivated: function(activeConnection) {
        if (activeConnection.state == NM.ActiveConnectionState.ACTIVATED &&
            activeConnection._primaryDevice && activeConnection._primaryDevice._notification) {
                activeConnection._primaryDevice._notification.destroy();
                activeConnection._primaryDevice._notification = null;
        }

        this._updateIcon();
    },

    _readConnections: function() {
        let connections = this._client.get_connections();
        for (let i = 0; i < connections.length; i++) {
            let connection = connections[i];
            if (connection._uuid) {
                // connection was already seen (for example because NetworkManager was restarted)
                continue;
            }
            connection._updatedId = connection.connect('changed', Lang.bind(this, this._updateConnection));

            this._updateConnection(connection);
            this._connections.push(connection);
        }
    },

    _connectionAdded: function(client, connection) {
        if (connection._uuid) {
            // connection was already seen
            return;
        }

        connection._updatedId = connection.connect('changed', Lang.bind(this, this._updateConnection));

        this._updateConnection(connection);
        this._connections.push(connection);

        this._updateIcon();
    },

    _connectionRemoved: function(client, connection) {
        let pos = this._connections.indexOf(connection);
        if (pos != -1)
            this._connections.splice(pos, 1);

        let section = connection._section;

        if (section == NMConnectionCategory.VPN) {
            this._devices.vpn.device.removeConnection(connection);
            if (this._devices.vpn.device.empty)
                this._devices.vpn.section.actor.hide();
        } else if (section != NMConnectionCategory.INVALID) {
            let devices = this._devices[section].devices;
            for (let i = 0; i < devices.length; i++)
                devices[i].removeConnection(connection);
        }

        connection._uuid = null;
        connection.disconnect(connection._updatedId);
    },

    _updateConnection: function(connection) {
        let connectionSettings = connection.get_setting_by_name(NM.SETTING_CONNECTION_SETTING_NAME);
        connection._type = connectionSettings.type;

        connection._section = this._ctypes[connection._type] || NMConnectionCategory.INVALID;
        connection._name = connectionSettings.id;
        connection._uuid = connectionSettings.uuid;
        connection._timestamp = connectionSettings.timestamp;

        let section = connection._section;

        if (connection._section == NMConnectionCategory.INVALID)
            return;
        if (section == NMConnectionCategory.VPN) {
            this._devices.vpn.device.checkConnection(connection);
            this._devices.vpn.section.actor.show();
        } else {
            let devices = this._devices[section].devices;
            for (let i = 0; i < devices.length; i++) {
                devices[i].checkConnection(connection);
            }
        }
    },

    _hideDevices: function() {
        this._devicesHidden = true;

        for (let category in this._devices)
            this._devices[category].section.actor.hide();
    },

    _showNormal: function() {
        if (!this._devicesHidden) // nothing to do
            return;
        this._devicesHidden = false;

        this._statusSection.actor.hide();

        this._syncSectionTitle('wired');
        this._syncSectionTitle('wireless');
        this._syncSectionTitle('wwan');

        if (!this._devices.vpn.device.empty)
            this._devices.vpn.section.actor.show();
    },

    _syncNMState: function() {
        if (!this._client.nm_running) {
            log('NetworkManager is not running, hiding...');
            this.menu.close();
            this.actor.hide();
            return;
        } else
            this.actor.show();

        if (!this._client.networking_enabled) {
            this._setIcon('xsi-network-offline');
            this._hideLinkIcons();
            this._hideDevices();
            this._statusItem.label.text = _("Networking is disabled");
            this._statusSection.actor.show();
            return;
        }

        this._showNormal();
        this._updateIcon();
    },

    _updateIcon: function() {
        let new_delay = DEFAULT_PERIODIC_UPDATE_FREQUENCY_SECONDS;

        try {
            this._syncActiveConnections();
            let mc = this._mainConnection;

            if (!mc) {
                if (this._client.state == NM.State.CONNECTED_GLOBAL) {
                    // We are online through a device NetworkManager does not
                    // manage (for instance one configured in
                    // /etc/network/interfaces): there is no active connection
                    // to describe, but we are not offline either.
                    this._setIcon('xsi-network-wired');
                    this._setTooltip(_("Connected to the network") + " (" + _("unmanaged") + ")");
                } else {
                    this._setIcon('xsi-network-offline');
                    this._setTooltip(_("No connection"));
                }
            } else if (mc.state == NM.ActiveConnectionState.ACTIVATING) {
                new_delay = FAST_PERIODIC_UPDATE_FREQUENCY_SECONDS;
                switch (mc._section) {
                case NMConnectionCategory.WWAN:
                    this._setIcon('xsi-network-cellular-acquiring');
                    this._setTooltip(_("Connecting to the cellular network..."));
                    break;
                case NMConnectionCategory.WIRELESS:
                    this._setIcon('xsi-network-wireless-acquiring');
                    this._setTooltip(_("Connecting to the wireless network..."));
                    break;
                case NMConnectionCategory.WIRED:
                    this._setIcon('xsi-network-wired-acquiring');
                    this._setTooltip(_("Connecting to the wired network..."));
                    break;
                case NMConnectionCategory.VPN:
                    this._setIcon('xsi-network-vpn-acquiring');
                    this._setTooltip(_("Connecting to the VPN..."));
                    break;
                default:
                    // fallback to a generic connected icon
                    // (it could be a private connection of some other user)
                    this._setIcon('xsi-network-wired-acquiring');
                    this._setTooltip(_("Connecting to the network..."));
                }
            } else {
                let dev;
                let limited_conn = false;
                // let limited_conn = this._correctStateForTunnel(this._client.get_connectivity()) !== NM.ConnectivityState.FULL;

                switch (mc._section) {
                case NMConnectionCategory.WIRELESS:
                    dev = mc._primaryDevice;
                    if (dev) {
                        let ap = dev.device.active_access_point;
                        let mode = dev.device.mode;
                        if (!ap) {
                            if (mode != NM80211Mode.ADHOC) {
                                log('An active wireless connection, in infrastructure mode, involves no access point?');
                                break;
                            }
                            this._setIcon('xsi-network-wireless-connected');
                            this._setTooltip(_("Connected to the wireless network"));
                        } else {
                            if (limited_conn) {
                                this._setIcon('xsi-network-wireless-no-route');
                                this._setTooltip(_("Wireless connection") + ": " + ssidToLabel(ap.get_ssid()) + " " + _("(Limited connectivity)"));
                            } else {
                                this._setIcon('xsi-network-wireless-signal-' + signalToIcon(ap.strength) + apSecuritySuffix(dev, ap));
                                this._setTooltip(_("Wireless connection") + ": " + ssidToLabel(ap.get_ssid()) + " ("+ ap.strength +"%)");
                            }
                        }
                    } else {
                        log('Active connection with no primary device?');
                    }
                    break;
                case NMConnectionCategory.WIRED:
                    if (limited_conn) {
                        this._setIcon('xsi-network-wired-no-route');
                        this._setTooltip(_("Connected to the wired network") + " " + _("(Limited connectivity)"));

                    } else {
                        this._setIcon('xsi-network-wired');
                        this._setTooltip(_("Connected to the wired network"));
                    }
                    break;
                case NMConnectionCategory.WWAN:
                    dev = mc._primaryDevice;
                    if (!dev) {
                        log('Active connection with no primary device?');
                        break;
                    }
                    if (!dev.mobileDevice) {
                        // this can happen for bluetooth in PAN mode
                        this._setIcon('xsi-network-cellular-connected');
                        this._setTooltip(_("Connected to the cellular network"));
                        break;
                    }

                    if (limited_conn) {
                        this._setIcon('xsi-network-cellular-no-route');
                        this._setTooltip(_("Connected to the cellular network") + " " + _("(Limited connectivity)"));
                    } else {
                        this._setIcon('xsi-network-cellular-signal-' + signalToIcon(dev.mobileDevice.signal_quality));
                        this._setTooltip(_("Connected to the cellular network"));
                    }

                    break;
                case NMConnectionCategory.VPN:
                    // Should we indicate limited connectivity for VPNs like we do above? What if the connection is to
                    // a local machine? Need to test.
                    this._setIcon('xsi-network-vpn');
                    this._setTooltip(_("Connected to the VPN"));
                    break;
                default:
                    // fallback to a generic connected icon
                    // (it could be a private connection of some other user)
                    this._setIcon('xsi-network-wired');
                    this._setTooltip(_("Connected to the network"));
                    break;
                }
            }
            /* The switch above drew the applet's own icon from NM's main
               connection.  It is now only the fallback, for when no wired,
               Wi-Fi or VPN connection is up: offline, unmanaged, or mobile
               broadband alone.  Otherwise the per-kind icons replace it. */
            let drawn = this._drawLinkIcons();
            if (drawn.connecting)
                new_delay = FAST_PERIODIC_UPDATE_FREQUENCY_SECONDS;
        }
        catch (e) {
            global.logError(e);
        }

        if (this.menu.isOpen) {
            return FAST_PERIODIC_UPDATE_FREQUENCY_SECONDS;
        }

        return new_delay;
    },

    _periodicUpdateIcon: function() {
        let new_delay = this._updateIcon();
        this._lastConnectivityState = this._client.get_connectivity();

        // TODO: This can be unreliable with multiple interfaces, and libnm
        // can be flaky with its connectivity state - on one machine of mine,
        // I observed regular switching between full and limited connectivity,
        // when no noticeable change in my actual ability to reach the internet.
        // We might re-implement to be independent of libnm. For now just disable it.
        //
        // if (!this._checkingConnectivity) {
        //     // https://gitlab.freedesktop.org/NetworkManager/NetworkManager/-/issues/476
        //     if (this._v1_28_0) {
        //         this._checkingConnectivity = true;
        //         this._client.check_connectivity_async(null, Lang.bind(this, this._connectivityCheckCallback));
        //     } else
        //     if (this._nm_proxy != null) {
        //         this._checkingConnectivity = true;
        //         this._nm_proxy.CheckConnectivityRemote(Lang.bind(this, this._proxyConnectivityCheckCallback));
        //     }
        // }

        if (this._updateFrequencySeconds != new_delay) {
            this._restartPeriodicUpdateTimer(new_delay);
        } else {
            return GLib.SOURCE_CONTINUE;
        }

        return GLib.SOURCE_REMOVE;
    },

    _correctStateForTunnel(state) {
        if (state !== NM.ConnectivityState.LIMITED) {
            return state;
        }

        // if our primary connection state is 'limited', check if there's a tunnel
        // connection active, and assume 'full' if so - this prevents reporting limited
        // connectivity when something like PIA vpn is active. This could end up reporting
        // a full connection when there isn't one, depending on what the tunnel is for,
        // but NM doesn't seem to provide any way to discern a relationship between a virtual
        // device (tunnel) and the physical device in use. The physical device is always returned
        // as the primary.

        if (this._activeConnections.some(con => con.get_connection_type() === "tun")) {
            return NM.ConnectivityState.FULL;
        }

        if (this._activeConnections.some(con => con.get_connection_type() === "wireguard")) {
            return NM.ConnectivityState.FULL;
        }

        return state;
    },

    _proxyConnectivityCheckCallback(new_state) {
        let state = this._correctStateForTunnel(new_state[0]);

        if (state !== this._lastConnectivityState) {
            this._updateIcon();
        }

        this._checkingConnectivity = false;
    },

    _connectivityCheckCallback(source, result) {
        let new_state = NM.ConnectivityState.UNKNOWN;

        try {
            new_state = source.check_connectivity_finish(result);
        } catch (e) {
            log(e);
        }

        let state = this._correctStateForTunnel(new_state);

        if (state !== this._lastConnectivityState) {
            this._updateIcon();
        }

        this._checkingConnectivity = false;
    },

    _restartPeriodicUpdateTimer: function(new_delay) {
        if (this._periodicTimeoutId > 0) {
            Mainloop.source_remove(this._periodicTimeoutId);
        }

        this._updateFrequencySeconds = new_delay;

        this._periodicTimeoutId = Mainloop.timeout_add_seconds(this._updateFrequencySeconds, Lang.bind(this, this._periodicUpdateIcon));
    },

    _rescanAccessPoints: function() {
        try {
            let devices = this._devices.wireless.devices;

            for (let i = 0; i < devices.length; i++) {
                if (devices[i]._client.wireless_get_enabled()) {
                    devices[i].device.request_scan(null);
                }
            }
        } catch (gerror) {
            if (gerror.code == NM.DeviceError.NOTALLOWED) {
                // NM only allows a rescan every 10 seconds
                return;
            } else {
                log(gerror);
            }
        }
    },

    _onMenuOpenStateChanged: function(popup, open) {
        this._periodicUpdateIcon();

        if (open) {
            this._rescanAccessPoints();
        }
    },

    on_applet_removed_from_panel: function() {
        Main.systrayManager.unregisterTrayIconReplacement(this.metadata.uuid);
        Main.keybindingManager.removeXletHotKey(this, "network-open");
        if (this._periodicTimeoutId){
            Mainloop.source_remove(this._periodicTimeoutId);
        }
        this._watchSignal(null);
    },

};

function main(metadata, orientation, panel_height, instance_id) {
    return new CinnamonNetworkApplet(metadata, orientation, panel_height, instance_id);
}
