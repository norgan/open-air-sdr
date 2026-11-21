using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Threading;
using System.Windows.Forms;

internal static class Launcher
{
    private const string Url = "http://127.0.0.1:8877";

    [STAThread]
    private static void Main()
    {
        Application.EnableVisualStyles();
        try
        {
            if (!Ready())
            {
                string root = AppDomain.CurrentDomain.BaseDirectory;
                string server = Path.Combine(root, "server.mjs");
                if (!File.Exists(server))
                    throw new InvalidOperationException("Keep Open Air.exe in the folder with server.mjs and the app files.");
                var start = new ProcessStartInfo(FindNode(), "\"" + server + "\"");
                start.WorkingDirectory = root;
                start.UseShellExecute = false;
                start.CreateNoWindow = true;
                start.EnvironmentVariables["OPEN_AIR_PORT"] = "8877";
                using (Process worker = Process.Start(start))
                {
                    for (int i = 0; i < 28; i++)
                    {
                        if (Ready()) break;
                        if (worker.HasExited) throw new InvalidOperationException("The Open Air service did not start. Check that port 8877 is free.");
                        Thread.Sleep(180);
                    }
                }
                if (!Ready()) throw new InvalidOperationException("Open Air did not become ready. Check that port 8877 is free.");
            }
            Process.Start(new ProcessStartInfo(Url) { UseShellExecute = true });
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "Open Air", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
    }

    private static bool Ready()
    {
        try
        {
            var request = (HttpWebRequest)WebRequest.Create(Url + "/api/health");
            request.Proxy = null;
            request.AllowAutoRedirect = false;
            request.Timeout = 350;
            request.ReadWriteTimeout = 350;
            using (var response = request.GetResponse())
            using (var reader = new StreamReader(response.GetResponseStream()))
                return reader.ReadToEnd().Contains("\"app\":\"open-air\"");
        }
        catch (WebException) { return false; }
    }

    private static string FindNode()
    {
        string installed = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe");
        if (File.Exists(installed)) return installed;
        foreach (string entry in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
        {
            if (String.IsNullOrWhiteSpace(entry)) continue;
            try
            {
                string candidate = Path.Combine(entry.Trim('"'), "node.exe");
                if (File.Exists(candidate)) return candidate;
            }
            catch (ArgumentException) {}
        }
        throw new InvalidOperationException("Install Node.js 22 or newer to run Open Air.");
    }
}
