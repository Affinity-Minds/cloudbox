// The Windows Desktop SDK's own implicit-usings set (UseWPF) does not match the plain
// Microsoft.NET.Sdk one (System.Net.Http, System.IO, System.Linq are not automatically included,
// unlike in apps/cloudbox-agent, which has no UseWPF). Rather than re-deriving that list by trial
// and error per file, declare the ones this project actually needs once, here.
global using System;
global using System.Collections.Generic;
global using System.IO;
global using System.Linq;
global using System.Net.Http;
global using System.Threading;
global using System.Threading.Tasks;
