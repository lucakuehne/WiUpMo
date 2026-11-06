using System.Drawing;
using System.Globalization;
using System.Windows.Forms;

namespace WiUpMo.Agent.Restart;

/// <summary>
/// Die Meldung beim Benutzer: neu starten oder verschieben, zuletzt nur noch
/// ein Countdown.
///
/// Ein eigenes Fenster statt einer Windows-Benachrichtigung: Die verschwindet
/// unter „Nicht stoeren" oder bei abgeschalteten Benachrichtigungen, und ein
/// Neustart, von dem niemand wusste, ist genau das, was die Meldung verhindern
/// soll. Es bleibt im Vordergrund und laesst sich nicht wegklicken — nur durch
/// eine Wahl.
/// </summary>
internal sealed class RestartPromptForm : Form
{
    private static readonly string[] Weekdays = ["So.", "Mo.", "Di.", "Mi.", "Do.", "Fr.", "Sa."];

    private readonly PromptRequest _request;
    private readonly System.Windows.Forms.Timer _timer = new() { Interval = 1000 };
    private readonly Label _deadline;
    private readonly Label _left;
    private readonly Label _countdown;
    private readonly ComboBox _choices;
    private readonly Button _defer;
    private readonly Button _now;

    private DateTimeOffset? _countdownEnd;
    private bool _closingFromOutside;

    public RestartPromptForm(PromptRequest request)
    {
        _request = request;

        Text = "Neustart erforderlich";
        Icon = SystemIcons.Information;
        Font = new Font("Segoe UI", 10f);
        AutoScaleMode = AutoScaleMode.Dpi;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        ControlBox = false;
        MaximizeBox = false;
        MinimizeBox = false;
        TopMost = true;
        ShowInTaskbar = true;
        StartPosition = FormStartPosition.CenterScreen;
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        Padding = new Padding(24, 20, 24, 20);
        BackColor = SystemColors.Window;

        var maxText = new Size(520, 0);
        var layout = new TableLayoutPanel
        {
            ColumnCount = 1,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            Dock = DockStyle.Fill,
        };

        layout.Controls.Add(new Label
        {
            Text = "Ihr Computer muss neu gestartet werden",
            Font = new Font("Segoe UI Semibold", 13f),
            AutoSize = true,
            MaximumSize = maxText,
            Margin = new Padding(0, 0, 0, 12),
        });

        layout.Controls.Add(TextLabel(
            string.IsNullOrWhiteSpace(request.Reason)
                ? "Ihre IT hat einen Neustart angefordert."
                : $"Ihre IT hat einen Neustart angefordert: {request.Reason}",
            maxText));

        if (!string.IsNullOrWhiteSpace(request.Message))
        {
            layout.Controls.Add(TextLabel(request.Message, maxText));
        }

        _deadline = TextLabel(
            $"Bitte speichern Sie Ihre Arbeit. Spätestens {When(request.Deadline)} wird der Computer neu gestartet.",
            maxText);
        layout.Controls.Add(_deadline);

        _left = TextLabel(
            request.DeferralsLeft == 1
                ? "Sie können den Neustart noch einmal verschieben."
                : $"Sie können den Neustart noch {request.DeferralsLeft}-mal verschieben.",
            maxText);
        _left.ForeColor = SystemColors.GrayText;
        layout.Controls.Add(_left);

        _countdown = new Label
        {
            AutoSize = true,
            MaximumSize = maxText,
            Font = new Font("Segoe UI Semibold", 12f),
            Margin = new Padding(0, 4, 0, 12),
            Visible = false,
        };
        layout.Controls.Add(_countdown);

        _choices = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Width = 210, Margin = new Padding(0, 4, 8, 0) };
        foreach (PromptOption option in request.Options)
        {
            _choices.Items.Add(option);
        }

        if (_choices.Items.Count > 0)
        {
            _choices.SelectedIndex = 0;
        }

        _defer = new Button { Text = "Verschieben", AutoSize = true, Padding = new Padding(8, 2, 8, 2), Margin = new Padding(0, 3, 24, 0) };
        _now = new Button { Text = "Jetzt neu starten", AutoSize = true, Padding = new Padding(8, 2, 8, 2), Margin = new Padding(0, 3, 0, 0) };

        var buttons = new FlowLayoutPanel
        {
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            FlowDirection = FlowDirection.LeftToRight,
            WrapContents = false,
            Margin = new Padding(0, 8, 0, 0),
        };
        buttons.Controls.AddRange([_choices, _defer, _now]);
        layout.Controls.Add(buttons);

        Controls.Add(layout);

        _defer.Click += (_, _) =>
        {
            if (_choices.SelectedItem is PromptOption option)
            {
                Finish(new PromptAnswer { Choice = "defer", Until = option.Until });
            }
        };
        _now.Click += (_, _) => Finish(new PromptAnswer { Choice = "now" });
        _timer.Tick += (_, _) => OnTick();

        Load += (_, _) =>
        {
            if (request.Final || request.Options.Count == 0 || request.DeferralsLeft <= 0)
            {
                EnterCountdown();
            }

            _timer.Start();
            Activate();
        };
    }

    /// <summary>Die Wahl; null, wenn die Meldung von aussen geschlossen wurde.</summary>
    public PromptAnswer? Answer { get; private set; }

    /// <summary>Der Dienst hat die Verbindung beendet — der Auftrag ist weggefallen.</summary>
    public void CloseFromOutside()
    {
        _closingFromOutside = true;
        Close();
    }

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

    private void OnTick()
    {
        DateTimeOffset now = DateTimeOffset.Now;

        if (_countdownEnd is { } end)
        {
            TimeSpan left = end - now;
            if (left <= TimeSpan.Zero)
            {
                Finish(new PromptAnswer { Choice = "timeout" });
                return;
            }

            _countdown.Text = string.Create(
                CultureInfo.InvariantCulture,
                $"Der Computer wird in {(int)left.TotalMinutes:00}:{left.Seconds:00} neu gestartet.");
            return;
        }

        if (now >= _request.Deadline)
        {
            EnterCountdown();
        }
    }

    /// <summary>Nicht mehr verschiebbar: nur noch „Jetzt neu starten" und die verbleibende Zeit.</summary>
    private void EnterCountdown()
    {
        _countdownEnd = DateTimeOffset.Now.AddMinutes(Math.Clamp(_request.CountdownMinutes, 1, 60));
        _choices.Visible = false;
        _defer.Visible = false;
        _left.Visible = false;
        _deadline.Text = "Der Neustart lässt sich nicht weiter verschieben. Bitte speichern Sie jetzt Ihre Arbeit.";
        _countdown.Visible = true;
        OnTick();
    }

    private void Finish(PromptAnswer answer)
    {
        Answer = answer;
        Close();
    }

    private static Label TextLabel(string text, Size maxSize) => new()
    {
        Text = text,
        AutoSize = true,
        MaximumSize = maxSize,
        Margin = new Padding(0, 0, 0, 10),
    };

    /// <summary>„heute um 14:00 Uhr", „morgen um 08:00 Uhr" oder „Fr., 07.11. um 14:00 Uhr".</summary>
    private static string When(DateTimeOffset at)
    {
        DateTime local = at.ToLocalTime().DateTime;
        DateTime today = DateTime.Today;
        string day = local.Date == today ? "heute"
            : local.Date == today.AddDays(1) ? "morgen"
            : $"am {Weekdays[(int)local.DayOfWeek]}, {local.ToString("dd.MM.", CultureInfo.InvariantCulture)}";
        return $"{day} um {local.ToString("HH:mm", CultureInfo.InvariantCulture)} Uhr";
    }
}
