using System.Drawing;
using System.Drawing.Text;
using System.Globalization;
using System.Media;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Microsoft.Win32;

namespace WiUpMo.Agent.Restart;

/// <summary>
/// Die Meldung beim Benutzer: neu starten oder verschieben, zuletzt nur noch
/// ein Countdown.
///
/// Ein eigenes Fenster statt einer Windows-Benachrichtigung: Die verschwindet
/// unter „Nicht stoeren" oder bei abgeschalteten Benachrichtigungen, und ein
/// Neustart, von dem niemand wusste, ist genau das, was die Meldung verhindern
/// soll. Es bleibt im Vordergrund und laesst sich nicht wegklicken oder
/// minimieren — nur durch eine Wahl schliessen.
///
/// Es holt sich dabei nicht den Fokus: Wer gerade schreibt, wuerde sonst mit
/// Leertaste oder Eingabetaste ungewollt neu starten. Stattdessen blinkt es in
/// der Taskleiste, und nach dem Aktivieren zaehlen Tasten erst nach einer
/// Sekunde.
/// </summary>
internal sealed class RestartPromptForm : Form
{
    private const int TextWidth = 560;
    private const int WsExTopmost = 0x00000008;
    private const string RestartGlyph = "";

    private static readonly TimeSpan KeyGuard = TimeSpan.FromSeconds(1);
    private static readonly string[] Weekdays = ["So.", "Mo.", "Di.", "Mi.", "Do.", "Fr.", "Sa."];

    private readonly PromptRequest _request;
    private readonly Palette _palette;
    private readonly System.Windows.Forms.Timer _timer = new() { Interval = 1000 };
    private readonly RichTextBox _deadline;
    private readonly Label _left;
    private readonly Panel _countdownPanel;
    private readonly Label _countdown;
    private readonly Panel _barFill;
    private readonly ComboBox _choices;
    private readonly Button _defer;
    private readonly Button _now;

    private DateTimeOffset? _countdownStart;
    private DateTimeOffset? _countdownEnd;
    private DateTime _keysFrom = DateTime.MinValue;
    private bool _closingFromOutside;
    private string _deadlineText = string.Empty;
    private string? _deadlineBold;

    public RestartPromptForm(PromptRequest request)
    {
        _request = request;
        _palette = Palette.Current();

        Text = "Neustart erforderlich";
        Icon = GlyphIcon(_palette.Accent);
        Font = new Font(Fonts.Text, 10f);
        BackColor = _palette.Background;
        ForeColor = _palette.Text;
        AutoScaleMode = AutoScaleMode.Dpi;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        ControlBox = false;
        MaximizeBox = false;
        MinimizeBox = false;
        ShowInTaskbar = true;
        StartPosition = FormStartPosition.CenterScreen;
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        Padding = Padding.Empty;
        KeyPreview = true;

        // --- Inhalt ------------------------------------------------------------

        var content = Column(new Padding(29, 24, 29, 12));

        var header = new TableLayoutPanel
        {
            ColumnCount = 2,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            Margin = new Padding(0, 0, 0, 16),
        };
        header.Controls.Add(new Label
        {
            Text = RestartGlyph,
            Font = new Font(Fonts.Icons, 20f),
            ForeColor = _palette.Accent,
            AutoSize = true,
            Anchor = AnchorStyles.Left,
            Margin = new Padding(0, 0, 10, 0),
        });
        header.Controls.Add(new Label
        {
            Text = "Ihr Computer muss neu gestartet werden",
            Font = new Font("Segoe UI Semibold", 14f),
            AutoSize = true,
            MaximumSize = new Size(TextWidth - 48, 0),
            Anchor = AnchorStyles.Left,
            Margin = Padding.Empty,
        });
        content.Controls.Add(header);

        string body = PromptTemplate.Render(request.Template, new Dictionary<string, string>
        {
            ["grund"] = request.Reason?.Trim() ?? string.Empty,
            ["frist"] = When(request.Deadline),
            ["verschiebungen"] = request.DeferralsLeft.ToString(CultureInfo.InvariantCulture),
            ["computer"] = Environment.MachineName,
            ["benutzer"] = Environment.UserName,
        });
        if (body.Length > 0)
        {
            content.Controls.Add(TextLabel(body, new Padding(0, 0, 0, 14)));
        }

        _deadline = RichText();
        content.Controls.Add(_deadline);
        string when = When(request.Deadline);
        SetDeadline($"Bitte speichern Sie Ihre Arbeit. Spätestens {when} wird der Computer neu gestartet.", when);

        _left = TextLabel(
            request.DeferralsLeft == 1
                ? "Sie können den Neustart noch einmal verschieben."
                : $"Sie können den Neustart noch {request.DeferralsLeft}-mal verschieben.",
            new Padding(0, 0, 0, 8));
        _left.ForeColor = _palette.Muted;
        content.Controls.Add(_left);

        // Der letzte Countdown: grosse Restzeit und ein Balken, in der letzten
        // Minute in Warnfarbe.
        _countdown = new Label
        {
            AutoSize = true,
            Font = new Font(Fonts.Display, 20f, FontStyle.Bold),
            Margin = new Padding(0, 0, 0, 8),
        };
        var bar = new Panel { Size = new Size(TextWidth, 6), BackColor = _palette.Track, Margin = Padding.Empty };
        _barFill = new Panel { Dock = DockStyle.Left, Width = TextWidth, BackColor = _palette.Accent };
        bar.Controls.Add(_barFill);

        var countdown = Column(Padding.Empty);
        countdown.Margin = new Padding(0, 4, 0, 8);
        countdown.Controls.Add(_countdown);
        countdown.Controls.Add(bar);
        countdown.Visible = false;
        _countdownPanel = countdown;
        content.Controls.Add(countdown);

        // --- Fusszeile: verschieben links, die Hauptaktion rechts ---------------

        _choices = new ComboBox
        {
            DropDownStyle = ComboBoxStyle.DropDownList,
            FlatStyle = FlatStyle.Flat,
            BackColor = _palette.Background,
            ForeColor = _palette.Text,
            Width = 210,
            Anchor = AnchorStyles.Left,
            Margin = new Padding(0, 0, 8, 0),
        };
        foreach (PromptOption option in request.Options)
        {
            _choices.Items.Add(option);
        }

        if (_choices.Items.Count > 0)
        {
            _choices.SelectedIndex = 0;
        }

        _defer = new Button
        {
            Text = "Verschieben",
            AutoSize = true,
            FlatStyle = FlatStyle.Flat,
            BackColor = _palette.Background,
            ForeColor = _palette.Text,
            Padding = new Padding(10, 3, 10, 3),
            Anchor = AnchorStyles.Left,
            Margin = Padding.Empty,
        };
        _defer.FlatAppearance.BorderColor = _palette.Border;

        _now = new Button
        {
            Text = "Jetzt neu starten",
            AutoSize = true,
            FlatStyle = FlatStyle.Flat,
            BackColor = _palette.Accent,
            ForeColor = _palette.OnAccent,
            Font = new Font(Fonts.Text, 10f, FontStyle.Bold),
            Padding = new Padding(14, 3, 14, 3),
            Anchor = AnchorStyles.Right,
            Margin = new Padding(24, 0, 0, 0),
        };
        _now.FlatAppearance.BorderSize = 0;
        _now.FlatAppearance.MouseOverBackColor = _palette.AccentHover;
        _now.FlatAppearance.MouseDownBackColor = _palette.AccentHover;

        var footer = new TableLayoutPanel
        {
            ColumnCount = 4,
            RowCount = 1,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            Dock = DockStyle.Fill,
            BackColor = _palette.Footer,
            Padding = new Padding(29, 14, 29, 14),
            Margin = Padding.Empty,
        };
        footer.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        footer.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        footer.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));
        footer.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        footer.Controls.Add(_choices, 0, 0);
        footer.Controls.Add(_defer, 1, 0);
        footer.Controls.Add(_now, 3, 0);

        // --- Zusammensetzen: Farbbalken, Inhalt, Fusszeile ----------------------

        var root = Column(Padding.Empty);
        root.Controls.Add(new Panel { Height = 4, Dock = DockStyle.Fill, BackColor = _palette.Accent, Margin = Padding.Empty });
        root.Controls.Add(content);
        root.Controls.Add(footer);
        Controls.Add(root);

        // --- Verhalten -----------------------------------------------------------

        _defer.Click += (_, _) =>
        {
            if (_choices.SelectedItem is PromptOption option)
            {
                Finish(new PromptAnswer { Choice = "defer", Until = option.Until });
            }
        };
        _now.Click += (_, _) => Finish(new PromptAnswer { Choice = "now" });
        _timer.Tick += (_, _) => OnTick();
        Activated += (_, _) => _keysFrom = DateTime.UtcNow + KeyGuard;

        // Nicht auf „Jetzt neu starten": Wer die Meldung mit der Tastatur
        // erreicht, soll nicht als Erstes auf dem Neustart landen.
        _deadline.GotFocus += (_, _) => (_choices.Visible ? (Control)_choices : _now).Focus();
        ActiveControl = _choices;

        Load += (_, _) =>
        {
            if (request.Final || request.Options.Count == 0 || request.DeferralsLeft <= 0)
            {
                EnterCountdown();
            }

            _timer.Start();
        };
        Shown += (_, _) => Flash();
    }

    /// <summary>Die Wahl; null, wenn die Meldung von aussen geschlossen wurde.</summary>
    public PromptAnswer? Answer { get; private set; }

    /// <summary>Erscheint, ohne den Fokus zu nehmen.</summary>
    protected override bool ShowWithoutActivation => true;

    /// <summary>
    /// Im Vordergrund ueber die Fensterklasse statt ueber <c>TopMost</c>: Das
    /// Setzen der Eigenschaft holte das Fenster nach vorn und mit ihm den Fokus.
    /// </summary>
    protected override CreateParams CreateParams
    {
        get
        {
            CreateParams parameters = base.CreateParams;
            parameters.ExStyle |= WsExTopmost;
            return parameters;
        }
    }

    /// <summary>Der Dienst hat die Verbindung beendet — der Auftrag ist weggefallen.</summary>
    public void CloseFromOutside()
    {
        _closingFromOutside = true;
        Close();
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);

        // Windows 11: abgerundete Ecken, im dunklen Modus eine dunkle Titelleiste.
        // Aeltere Fassungen kennen die Attribute nicht und uebergehen sie.
        int round = NativeMethods.DwmCornerRound;
        NativeMethods.DwmSetWindowAttribute(Handle, NativeMethods.DwmWindowCornerPreference, ref round, sizeof(int));
        int dark = _palette.Dark ? 1 : 0;
        NativeMethods.DwmSetWindowAttribute(Handle, NativeMethods.DwmUseImmersiveDarkMode, ref dark, sizeof(int));
    }

    protected override void OnKeyDown(KeyEventArgs e)
    {
        if (KeysBlocked)
        {
            e.Handled = true;
            e.SuppressKeyPress = true;
            return;
        }

        base.OnKeyDown(e);
    }

    protected override void OnKeyUp(KeyEventArgs e)
    {
        if (KeysBlocked)
        {
            e.Handled = true;
            return;
        }

        base.OnKeyUp(e);
    }

    /// <summary>Auch die Eingabetaste, die sonst die Schaltflaeche mit dem Fokus ausloest.</summary>
    protected override bool ProcessDialogKey(Keys keyData) => KeysBlocked || base.ProcessDialogKey(keyData);

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        // Wegklicken geht nicht; Abmelden und Herunterfahren schon.
        if (Answer is null && !_closingFromOutside && e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            return;
        }

        _timer.Stop();
        base.OnFormClosing(e);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _timer.Dispose();
        }

        base.Dispose(disposing);
    }

    private bool KeysBlocked => DateTime.UtcNow < _keysFrom;

    private void OnTick()
    {
        DateTimeOffset now = DateTimeOffset.Now;

        if (_countdownEnd is { } end && _countdownStart is { } start)
        {
            TimeSpan left = end - now;
            if (left <= TimeSpan.Zero)
            {
                Finish(new PromptAnswer { Choice = "timeout" });
                return;
            }

            _countdown.Text = string.Create(
                CultureInfo.InvariantCulture,
                $"Neustart in {(int)left.TotalMinutes:00}:{left.Seconds:00}");

            double share = left.TotalSeconds / Math.Max(1, (end - start).TotalSeconds);
            _barFill.Width = (int)Math.Round(_barFill.Parent!.Width * Math.Clamp(share, 0, 1));

            Color tone = left <= TimeSpan.FromMinutes(1) ? _palette.Warning : _palette.Accent;
            _countdown.ForeColor = tone;
            _barFill.BackColor = tone;
            return;
        }

        if (now >= _request.Deadline)
        {
            EnterCountdown();
        }
    }

    /// <summary>
    /// Nicht mehr verschiebbar: nur noch „Jetzt neu starten" und die
    /// verbleibende Zeit — mit Signalton und Blinken in der Taskleiste.
    /// </summary>
    private void EnterCountdown()
    {
        DateTimeOffset now = DateTimeOffset.Now;
        _countdownStart = now;
        _countdownEnd = now.AddMinutes(Math.Clamp(_request.CountdownMinutes, 1, 60));
        _choices.Visible = false;
        _defer.Visible = false;
        _left.Visible = false;
        SetDeadline("Der Neustart lässt sich nicht weiter verschieben. Bitte speichern Sie jetzt Ihre Arbeit.", bold: null);
        _countdownPanel.Visible = true;
        SystemSounds.Exclamation.Play();
        Flash();
        OnTick();
    }

    private void Finish(PromptAnswer answer)
    {
        Answer = answer;
        Close();
    }

    /// <summary>Blinkt in der Taskleiste, bis das Fenster vorn ist.</summary>
    private void Flash()
    {
        if (!IsHandleCreated)
        {
            return;
        }

        var info = new NativeMethods.FlashInfo
        {
            Size = Marshal.SizeOf<NativeMethods.FlashInfo>(),
            Window = Handle,
            Flags = NativeMethods.FlashAll | NativeMethods.FlashUntilForeground,
        };
        NativeMethods.FlashWindowEx(ref info);
    }

    /// <summary>Der Satz zur Frist, der Zeitpunkt darin fett.</summary>
    private void SetDeadline(string text, string? bold)
    {
        _deadlineText = text;
        _deadlineBold = bold;
        _deadline.Text = text;
        FormatDeadline();
    }

    /// <summary>
    /// Formatierung haelt erst, wenn das Steuerelement sein Handle hat — davor
    /// geht sie beim Anlegen verloren. Deshalb auch bei jedem neuen Handle.
    /// </summary>
    private void FormatDeadline()
    {
        if (!_deadline.IsHandleCreated)
        {
            return;
        }

        if (_deadline.Text != _deadlineText)
        {
            _deadline.Text = _deadlineText;
        }

        _deadline.SelectAll();
        _deadline.SelectionFont = Font;

        int start = _deadlineBold is null ? -1 : _deadlineText.IndexOf(_deadlineBold, StringComparison.Ordinal);
        if (start >= 0)
        {
            _deadline.Select(start, _deadlineBold!.Length);
            _deadline.SelectionFont = new Font(Font, FontStyle.Bold);
        }

        _deadline.Select(0, 0);
    }

    /// <summary>Text mit fett gesetzten Stellen; die Hoehe folgt dem Inhalt.</summary>
    private RichTextBox RichText()
    {
        var box = new RichTextBox
        {
            ReadOnly = true,
            BorderStyle = BorderStyle.None,
            ScrollBars = RichTextBoxScrollBars.None,
            DetectUrls = false,
            TabStop = false,
            Cursor = Cursors.Default,
            // Zwei Punkte eingerueckt: Labels zeichnen ihren Text mit diesem Abstand.
            Width = TextWidth - 2,
            Height = 44,
            Margin = new Padding(2, 0, 0, 10),
        };

        // Erst nach ReadOnly: Das setzt sonst die Hintergrundfarbe zurueck.
        box.BackColor = _palette.Background;
        box.ForeColor = _palette.Text;
        box.ContentsResized += (_, e) => box.Height = e.NewRectangle.Height + 2;
        box.HandleCreated += (_, _) => FormatDeadline();
        return box;
    }

    private static Label TextLabel(string text, Padding margin) => new()
    {
        Text = text,
        AutoSize = true,
        MaximumSize = new Size(TextWidth, 0),
        Margin = margin,
    };

    private static TableLayoutPanel Column(Padding padding) => new()
    {
        ColumnCount = 1,
        AutoSize = true,
        AutoSizeMode = AutoSizeMode.GrowAndShrink,
        Padding = padding,
        Margin = Padding.Empty,
    };

    /// <summary>Das Neustart-Symbol auch in Titelleiste und Taskleiste.</summary>
    private static Icon GlyphIcon(Color color)
    {
        using var bitmap = new Bitmap(32, 32);
        using (Graphics graphics = Graphics.FromImage(bitmap))
        using (var font = new Font(Fonts.Icons, 22f, GraphicsUnit.Pixel))
        using (var brush = new SolidBrush(color))
        using (var format = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center })
        {
            graphics.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
            graphics.DrawString(RestartGlyph, font, brush, new RectangleF(0, 0, 32, 32), format);
        }

        // Der Prozess lebt nur so lange wie die Meldung; das Handle gibt Windows
        // mit ihm frei.
        return Icon.FromHandle(bitmap.GetHicon());
    }

    /// <summary>„heute um 14:00 Uhr", „morgen um 08:00 Uhr" oder „am Fr., 07.11. um 14:00 Uhr".</summary>
    private static string When(DateTimeOffset at)
    {
        DateTime local = at.ToLocalTime().DateTime;
        DateTime today = DateTime.Today;
        string day = local.Date == today ? "heute"
            : local.Date == today.AddDays(1) ? "morgen"
            : $"am {Weekdays[(int)local.DayOfWeek]}, {local.ToString("dd.MM.", CultureInfo.InvariantCulture)}";
        return $"{day} um {local.ToString("HH:mm", CultureInfo.InvariantCulture)} Uhr";
    }

    /// <summary>Die Schriften von Windows 11, auf Windows 10 die Vorgaenger.</summary>
    private static class Fonts
    {
        public static readonly string Text = Installed("Segoe UI Variable Text") ?? "Segoe UI";
        public static readonly string Display = Installed("Segoe UI Variable Display") ?? "Segoe UI";
        public static readonly string Icons = Installed("Segoe Fluent Icons") ?? "Segoe MDL2 Assets";

        private static string? Installed(string family)
        {
            using var fonts = new InstalledFontCollection();
            return fonts.Families.Any(f => f.Name.Equals(family, StringComparison.OrdinalIgnoreCase)) ? family : null;
        }
    }

    /// <summary>
    /// Hell oder dunkel, wie der Benutzer es fuer Apps eingestellt hat. Die
    /// Akzentfarbe ist das Blau von Windows 11 — im dunklen Modus die hellere
    /// Stufe mit dunkler Schrift, wie Windows es selbst haelt.
    /// </summary>
    private sealed record Palette(
        bool Dark,
        Color Background,
        Color Footer,
        Color Text,
        Color Muted,
        Color Border,
        Color Track,
        Color Accent,
        Color AccentHover,
        Color OnAccent,
        Color Warning)
    {
        private static readonly Palette Light = new(
            Dark: false,
            Background: Color.White,
            Footer: Color.FromArgb(0xF3, 0xF3, 0xF3),
            Text: Color.FromArgb(0x1A, 0x1A, 0x1A),
            Muted: Color.FromArgb(0x5F, 0x5F, 0x5F),
            Border: Color.FromArgb(0xC8, 0xC8, 0xC8),
            Track: Color.FromArgb(0xE0, 0xE0, 0xE0),
            Accent: Color.FromArgb(0x00, 0x67, 0xC0),
            AccentHover: Color.FromArgb(0x19, 0x75, 0xC5),
            OnAccent: Color.White,
            Warning: Color.FromArgb(0xC4, 0x2B, 0x1C));

        private static readonly Palette DarkTheme = new(
            Dark: true,
            Background: Color.FromArgb(0x20, 0x20, 0x20),
            Footer: Color.FromArgb(0x2B, 0x2B, 0x2B),
            Text: Color.White,
            Muted: Color.FromArgb(0xA0, 0xA0, 0xA0),
            Border: Color.FromArgb(0x55, 0x55, 0x55),
            Track: Color.FromArgb(0x3A, 0x3A, 0x3A),
            Accent: Color.FromArgb(0x4C, 0xC2, 0xFF),
            AccentHover: Color.FromArgb(0x47, 0xB1, 0xE8),
            OnAccent: Color.Black,
            Warning: Color.FromArgb(0xFF, 0x99, 0xA4));

        public static Palette Current()
        {
            using RegistryKey? key = Registry.CurrentUser.OpenSubKey(
                @"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
            return key?.GetValue("AppsUseLightTheme") is 0 ? DarkTheme : Light;
        }
    }
}
