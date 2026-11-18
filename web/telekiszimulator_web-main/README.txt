TELEKI SZIMULÁTOR – WPF-ből weboldalba
======================================

Mi ez?
------
A TelekiSzimulator nevű WPF (C#/.NET) alkalmazás webes másolata
HTML, CSS és JavaScript segítségével. Elágazó, jelenetekből álló
történeteket lehet benne szerkeszteni és végigjátszani. A felület,
a színek, a szövegek és a működés az eredeti alkalmazást követik.

Az eredeti WPF projekt:
https://github.com/vendlnotfoundedu/TelekiSzimulator

Fájlok
------
index.html   Az oldal vázát tartalmazza.
style.css    A kinézet (színek, kártyák, szerkesztő és játékos elrendezés).
app.js       Az egész működés: kezdőlap, szerkesztő, játékos, mentés.
README.txt   Ez a leírás.

Indítás
-------
1. Töltsd le vagy klónozd a repót.
2. Nyisd meg az index.html fájlt a böngészőben.

Ha a böngésző a fájlok közvetlen megnyitásánál hibát jelez, indíts egy
helyi szervert a mappában, például:

    python -m http.server

majd nyisd meg a http://localhost:8000 címet.

Használat
---------
Kezdőlap
  Szerkesztő   Történetek készítése és módosítása.
  Játék        Mentett történet kiválasztása és végigjátszása.

Szerkesztő
  - Új történet: add meg a nevét felül, majd vegyél fel jeleneteket.
  - Jelenet: cím, szint, szöveg, média és választások adhatók meg.
  - Az első mentett jelenet automatikusan a kezdőjelenet (★).
  - Záró jelenetnek (■) a jelölőnégyzettel lehet megjelölni.
  - A jelenetek a kezdő, a szintek szerint rendezett, majd a záró
    jelenetek sorrendjében jelennek meg.
  - Média: png, jpg, bmp, gif, mp4, mp3 (a wmv-t a legtöbb böngésző
    nem játssza le).
  - Ha a történetben nincs jelenet, a Jelenet törlése gomb Történet
    törlése gombra változik, és az egész történetet törli.

Játék
  - Válassz egy mentett történetet, majd kattints a választógombokra.
  - A záró jelenet után a Vissza a történetekhez gombbal lehet
    új történetet választani.

Mentés
------
A történetek és a médiafájlok a böngésző IndexedDB tárolójába kerülnek,
tehát az adott böngészőben és gépen maradnak meg. A böngészőadatok
törlése a történeteket is törli, ezért érdemes időnként exportálni.

Export / Import
---------------
Export   A megnyitott történetből zip fájl készül, benne:
             <történet neve>/story.json
             <történet neve>/media/...
         A zip tartalmát a WPF projekt Stories mappájába kicsomagolva
         a WPF alkalmazás is megnyitja a történetet.
Import   Az Import (mappa) gombbal egy Stories/<történet> mappát kell
         kiválasztani (benne a story.json és a media mappa). Így a WPF
         alkalmazásban készült történetek a weben is használhatók.

Ha az importált név már létezik, a program _uj végződést fűz hozzá.

Technikai részletek
-------------------
- Keretrendszer nélküli, tiszta HTML, CSS és JavaScript.
- Mentés: IndexedDB (történetek és médiafájlok külön tárolóban).
- A story.json formátuma megegyezik a WPF alkalmazáséval:
  title, start, scenes[id, title, level, ending, text, media,
  choices[label, next]].
- A zip export saját, tömörítetlen ZIP-íróval készül, külső
  könyvtár nélkül.

Ismert korlátok
---------------
- A wmv formátumot a legtöbb böngésző nem támogatja.
- A tárolás böngészőnként külön van, nincs szinkronizáció.
- A mappa-import használatához a böngésző engedélyét kell megadni.