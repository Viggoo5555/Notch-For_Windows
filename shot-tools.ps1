param(
  [Parameter(Mandatory = $true)][string]$Image,
  [ValidateSet('text', 'font')][string]$Mode = 'text'
)

# Reads a screenshot: Windows' own OCR engine gives the text, and for the font
# question the biggest line of that text is compared against every installed
# typeface by drawing it in each one and scoring the overlap with the picture.
#
# Runs as its own PowerShell process: a bad image or a font that will not render
# cannot take the keyboard hook down with it. One JSON object comes back on
# stdout, so a failure is still an answer.

$ErrorActionPreference = 'Stop'
$answer = @{ ok = $false; error = ''; text = ''; fonts = @() }

$fontSource = @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Globalization;
using System.Runtime.InteropServices;

public static class ShotFonts
{
    public static string[] Guess(string imagePath, int x, int y, int width, int height, string text)
    {
        List<string> ranked = new List<string>();
        try
        {
            if (text == null) return new string[0];
            text = text.Trim();
            if (text.Length == 0) return new string[0];
            if (text.Length > 48) text = text.Substring(0, 48);

            using (Bitmap whole = new Bitmap(imagePath))
            {
                Rectangle box = Rectangle.Intersect(
                    new Rectangle(x, y, width, height),
                    new Rectangle(0, 0, whole.Width, whole.Height));
                if (box.Width < 12 || box.Height < 8) return new string[0];

                int w = box.Width;
                int h = box.Height;
                if (w > 480)
                {
                    h = Math.Max(8, (int)Math.Round(h * (480.0 / w)));
                    w = 480;
                }

                Bitmap sample = null;
                try
                {
                    sample = new Bitmap(w, h, PixelFormat.Format24bppRgb);
                    using (Graphics g = Graphics.FromImage(sample))
                    {
                        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                        g.DrawImage(whole, new Rectangle(0, 0, w, h), box, GraphicsUnit.Pixel);
                    }

                    byte[] ink = Ink(sample, w, h);
                    if (ink == null) return new string[0];

                    List<KeyValuePair<string, double>> scores = new List<KeyValuePair<string, double>>();
                    using (InstalledFontCollection installed = new InstalledFontCollection())
                    {
                        foreach (FontFamily family in installed.Families)
                        {
                            string name = family.Name;
                            if (name == null || name.StartsWith("@")) continue;
                            if (!Wanted(name)) continue;
                            if (!family.IsStyleAvailable(FontStyle.Regular)) continue;
                            double score = Score(w, h, ink, text, family);
                            if (score > 0.05) scores.Add(new KeyValuePair<string, double>(name, score));
                        }
                    }

                    scores.Sort(delegate (KeyValuePair<string, double> a, KeyValuePair<string, double> b)
                    {
                        return b.Value.CompareTo(a.Value);
                    });
                    for (int i = 0; i < scores.Count && i < 4; i += 1)
                    {
                        ranked.Add(scores[i].Key + "\t" + scores[i].Value.ToString("0.000", CultureInfo.InvariantCulture));
                    }
                }
                finally
                {
                    if (sample != null) sample.Dispose();
                }
            }
        }
        catch
        {
            return new string[0];
        }
        return ranked.ToArray();
    }

    // Symbol and icon faces have no letters in common with a sentence, so they can
    // only ever score badly: leaving them out keeps the list honest.
    private static bool Wanted(string name)
    {
        string low = name.ToLower(CultureInfo.InvariantCulture);
        string[] skip = new string[]
        {
            "wingding", "webding", "marlett", "mdl2", "symbol", "icon", "emoji",
            "hololens", "bookshelf", "dingbat", "mt extra"
        };
        for (int i = 0; i < skip.Length; i += 1)
        {
            if (low.IndexOf(skip[i], StringComparison.Ordinal) >= 0) return false;
        }
        return true;
    }

    // Ink is whatever is furthest from the colour that covers most of the crop, so
    // light text on a dark button works as well as dark text on paper.
    private static byte[] Ink(Bitmap sample, int w, int h)
    {
        byte[] grays = new byte[w * h];
        int[] histogram = new int[256];
        BitmapData data = sample.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
        try
        {
            int stride = Math.Abs(data.Stride);
            byte[] row = new byte[stride];
            for (int y = 0; y < h; y += 1)
            {
                Marshal.Copy(IntPtr.Add(data.Scan0, y * data.Stride), row, 0, stride);
                for (int x = 0; x < w; x += 1)
                {
                    int b = row[x * 3];
                    int g = row[x * 3 + 1];
                    int r = row[x * 3 + 2];
                    int gray = (r * 30 + g * 59 + b * 11) / 100;
                    grays[y * w + x] = (byte)gray;
                    histogram[gray] += 1;
                }
            }
        }
        finally
        {
            sample.UnlockBits(data);
        }

        int background = 0;
        int most = -1;
        for (int i = 0; i < 256; i += 1)
        {
            if (histogram[i] > most) { most = histogram[i]; background = i; }
        }

        byte[] mask = new byte[w * h];
        int marked = 0;
        for (int i = 0; i < grays.Length; i += 1)
        {
            if (Math.Abs(grays[i] - background) > 58) { mask[i] = 1; marked += 1; }
        }
        // Nothing to compare, or so much ink that it is a photograph, not text.
        if (marked < 12 || marked > w * h * 0.9) return null;
        return mask;
    }

    // Draws the recognised line in one candidate face, stretched to the width the
    // line occupies on screen, and counts how much of the ink lands in the same
    // place. Shape agreement is what is being measured, not size.
    private static double Score(int w, int h, byte[] target, string text, FontFamily family)
    {
        double best = 0;
        using (Bitmap render = new Bitmap(w, h, PixelFormat.Format24bppRgb))
        {
            using (Graphics g = Graphics.FromImage(render))
            {
                g.Clear(Color.Black);
                g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
                float size = Math.Max(10f, h * 0.9f);
                using (Font font = new Font(family, size, FontStyle.Regular, GraphicsUnit.Pixel))
                {
                    SizeF measured = g.MeasureString(text, font, new PointF(0f, 0f), StringFormat.GenericTypographic);
                    if (measured.Width < 1f || measured.Height < 1f) return 0;
                    float scale = w / measured.Width;
                    if (scale > 6f) scale = 6f;
                    if (scale < 0.02f) return 0;
                    g.ScaleTransform(scale, scale);
                    float top = (h / scale - measured.Height) * 0.5f;
                    g.DrawString(text, font, Brushes.White, 0f, top, StringFormat.GenericTypographic);
                }
            }

            BitmapData data = render.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
            try
            {
                int stride = Math.Abs(data.Stride);
                byte[] row = new byte[stride];
                int hits = 0;
                int union = 0;
                for (int y = 0; y < h; y += 1)
                {
                    Marshal.Copy(IntPtr.Add(data.Scan0, y * data.Stride), row, 0, stride);
                    for (int x = 0; x < w; x += 1)
                    {
                        bool mine = row[x * 3] > 110;
                        bool theirs = target[y * w + x] != 0;
                        if (mine || theirs) union += 1;
                        if (mine && theirs) hits += 1;
                    }
                }
                if (union > 0) best = (double)hits / union;
            }
            finally
            {
                render.UnlockBits(data);
            }
        }
        return best;
    }
}
'@

function Write-Answer($value) {
  $value | ConvertTo-Json -Depth 5 -Compress
}

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]

  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
      $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]

  # WinRT hands back async operations; PowerShell cannot await, so they are turned
  # into tasks and waited on.
  function Await($operation, $type) {
    $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation))
    $task.Wait(-1) | Out-Null
    if ($task.IsFaulted) { throw $task.Exception.InnerException }
    $task.Result
  }

  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Image)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if ($null -eq $engine) {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('en-US'))
  }
  if ($null -eq $engine) { throw 'No OCR language is installed' }

  $ocr = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $lines = @($ocr.Lines)
  $answer.text = (@($lines | ForEach-Object { $_.Text }) -join "`n")
  $answer.ok = $true

  if ($Mode -eq 'font' -and $lines.Count -gt 0) {
    # The biggest line is the one worth comparing: the most pixels, and therefore
    # the most letter shapes to disagree about.
    $pick = $null
    $pickArea = 0
    foreach ($line in $lines) {
      $x1 = [double]::MaxValue
      $y1 = [double]::MaxValue
      $x2 = [double]::MinValue
      $y2 = [double]::MinValue
      foreach ($word in $line.Words) {
        $rect = $word.BoundingRect
        if ($rect.X -lt $x1) { $x1 = $rect.X }
        if ($rect.Y -lt $y1) { $y1 = $rect.Y }
        if (($rect.X + $rect.Width) -gt $x2) { $x2 = $rect.X + $rect.Width }
        if (($rect.Y + $rect.Height) -gt $y2) { $y2 = $rect.Y + $rect.Height }
      }
      $area = ($x2 - $x1) * ($y2 - $y1)
      if ($area -gt $pickArea) {
        $pickArea = $area
        $pick = @{ x = $x1; y = $y1; w = ($x2 - $x1); h = ($y2 - $y1); text = $line.Text }
      }
    }

    if ($null -ne $pick -and $pick.text) {
      Add-Type -ReferencedAssemblies @('System.Drawing', 'System') -TypeDefinition $fontSource
      $rows = [ShotFonts]::Guess(
        $Image,
        [int]$pick.x,
        [int]$pick.y,
        [int]$pick.w,
        [int]$pick.h,
        [string]$pick.text
      )
      $fonts = @()
      foreach ($row in $rows) {
        if (-not $row) { continue }
        $parts = $row.Split("`t")
        if ($parts.Count -lt 2) { continue }
        $fonts += @{ name = $parts[0]; score = [double]$parts[1] }
      }
      $answer.fonts = $fonts
    }
  }
} catch {
  $answer.ok = $false
  $answer.error = $_.Exception.Message
}

Write-Answer $answer
