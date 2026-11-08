(function (root, factory) {
  'use strict';
  const exported = factory();
  if (typeof module === 'object' && module.exports) module.exports = exported;
  if (root) root.FrameoGallery = exported;
}(typeof window === 'object' ? window : null, function () {
  'use strict';
  const PAGE_SIZE = 24;
  const PREVIEW_LIMIT = 4 * 1024 * 1024;
  const CACHE_BYTE_LIMIT = 8 * 1024 * 1024;
  const CACHE_PIXEL_LIMIT = 8000000;
  const translations = {
  "en": {
    "language": "en",
    "display_photo": "Display on the frame",
    "photo_action_pending": "Sending request…",
    "display_requested": "Display request sent to the frame.",
    "display_uncertain": "The display request could not be verified. Check the frame before trying again.",
    "flow_photo_name": "Photo name in Flows",
    "flow_photo_hint": "Name this photo to select it in a Flow. Homey saves a reference to the photo.",
    "flow_photo_save": "Save for Flows",
    "flow_photo_remove": "Remove from Flows",
    "flow_photo_saved": "This photo is now available in Flows.",
    "flow_photo_removed": "The reference was removed from Flows.",
    "flow_photo_limit": "The limit of 64 saved photo references has been reached.",
    "flow_photo_name_taken": "Another photo on this frame already uses that name.",
    "flow_photo_invalid": "Enter a name for this photo.",
    "title": "Your frame, a little closer",
    "intro": "Browse the photos on your frame, right here in Homey.",
    "frame_label": "Photo frame",
    "refresh": "Refresh",
    "photos": "Photos",
    "previous": "Previous",
    "next": "Next",
    "privacy": "Only the previews shown are loaded. They are kept temporarily for display.",
    "loading_frames": "Finding your frames…",
    "loading_photos": "Loading photos…",
    "loading_preview": "Loading preview…",
    "no_frames": "Add a Frameo photo frame in Homey to open its gallery.",
    "no_preview": "Preview unavailable",
    "video_thumbnail_unavailable": "Video thumbnail unavailable",
    "send_mode": "Sending only",
    "view_mode": "Viewing",
    "manage_mode": "Viewing and deletion",
    "friend_name": "Homey appears as “__name__” on this frame.",
    "enable": "Enable gallery",
    "disable": "Use sending only",
    "disabled_title": "Choose how Homey uses this frame",
    "disabled_intro": "Sending only is enabled. Open the gallery to view photos, if this Homey connection has permission.",
    "permission_title": "Check permission on the frame",
    "permission_intro": "Homey needs permission to view photos before it can open this gallery.",
    "permission_step_frame": "On the frame, open Settings → My friends.",
    "permission_step_friend": "Find “__name__”, the name used by this Homey connection.",
    "permission_step_access": "Check permission to view photos. Managing photos also allows deletion.",
    "permission_step_check": "Then return here to check access.",
    "permission_no_popup": "Permissions belong to this Homey connection. Nothing is requested automatically on the frame.",
    "check_access": "Check permissions",
    "checking": "Checking permissions…",
    "read_only": "You can view these photos. Deleting them also requires permission to manage photos.",
    "empty_title": "A little space for new memories",
    "empty": "There are no photos to display on this frame.",
    "count": "__count__ items",
    "page": "Page __page__",
    "hidden": "Hidden",
    "visible": "In the slideshow",
    "video": "Video",
    "greeting": "Greeting",
    "preview": "Preview",
    "unknown_date": "Date unavailable",
    "received": "Received __date__",
    "on_frame": "On this frame",
    "close": "Close",
    "keep": "Keep photo",
    "delete": "Permanently delete",
    "delete_warning": "This permanently deletes this photo from the selected frame. It cannot be undone.",
    "deleting": "Deleting this photo…",
    "deleted": "Photo deleted from the frame.",
    "delete_uncertain": "Deletion was not confirmed. Close this preview and refresh the gallery to check before trying any other deletion.",
    "refresh_required": "Refresh the gallery before deleting another photo.",
    "stale": "This gallery may have changed. Refresh to see the latest photos.",
    "error": "The gallery could not be loaded. Please try Refresh.",
    "preview_error": "This preview could not be loaded. Refresh the gallery to try again.",
    "busy": "Another operation is in progress. Try again in a moment.",
    "denied": "Access was not granted. Check this Homey connection’s permissions on the frame.",
    "unavailable": "The frame is unavailable. Check its connection, then refresh.",
    "invalid": "The frame returned an unexpected response. Please refresh.",
    "pagination_label": "Gallery pages",
    "photo_label": "__kind__ · __date__ · __visibility__",
    "filter_type": "Content",
    "filter_visibility": "Slideshow",
    "filter_sort": "Sort by",
    "filter_all": "All",
    "filter_photos": "Photos",
    "filter_videos": "Videos",
    "filter_greetings": "Greetings",
    "filter_visible": "Included in slideshow",
    "filter_hidden": "Hidden from slideshow",
    "sort_received_desc": "Received: newest first",
    "sort_received_asc": "Received: oldest first",
    "sort_captured_desc": "Captured: newest first",
    "sort_captured_asc": "Captured: oldest first",
    "hide": "Hide from slideshow",
    "show": "Include in slideshow",
    "hiding": "Hiding…",
    "showing": "Including in slideshow…",
    "visibility_changed": "Slideshow visibility updated.",
    "visibility_uncertain": "The change was not confirmed. Refresh the gallery before making another change.",
    "preview_budget": "This preview cannot fit in the available memory. Close a preview or refresh."
  },
  "fr": {
    "language": "fr",
    "display_photo": "Afficher sur le cadre",
    "photo_action_pending": "Demande en cours…",
    "display_requested": "Demande d’affichage envoyée au cadre.",
    "display_uncertain": "L’envoi de la demande d’affichage n’a pas pu être vérifié. Vérifiez le cadre avant de réessayer.",
    "flow_photo_name": "Nom de la photo dans les Flows",
    "flow_photo_hint": "Nommez cette photo pour la retrouver dans un Flow. Homey conserve uniquement sa référence.",
    "flow_photo_save": "Enregistrer pour les Flows",
    "flow_photo_remove": "Retirer des Flows",
    "flow_photo_saved": "Cette photo est maintenant disponible dans les Flows.",
    "flow_photo_removed": "La référence a été retirée des Flows.",
    "flow_photo_limit": "La limite de 64 références de photos est atteinte.",
    "flow_photo_name_taken": "Une autre photo de ce cadre porte déjà ce nom.",
    "flow_photo_invalid": "Saisissez un nom pour cette photo.",
    "title": "Votre cadre, un peu plus près",
    "intro": "Retrouvez les photos de votre cadre, ici dans Homey.",
    "frame_label": "Cadre photo",
    "refresh": "Actualiser",
    "photos": "Photos",
    "previous": "Précédent",
    "next": "Suivant",
    "privacy": "Seuls les aperçus affichés sont chargés. Ils sont conservés temporairement pour l’affichage.",
    "loading_frames": "Recherche de vos cadres…",
    "loading_photos": "Chargement des photos…",
    "loading_preview": "Chargement de l’aperçu…",
    "no_frames": "Ajoutez un cadre Frameo dans Homey pour ouvrir sa galerie.",
    "no_preview": "Aperçu indisponible",
    "video_thumbnail_unavailable": "Vignette vidéo indisponible",
    "send_mode": "Envoi uniquement",
    "view_mode": "Consultation",
    "manage_mode": "Consultation et suppression",
    "friend_name": "Homey apparaît sous le nom « __name__ » sur ce cadre.",
    "enable": "Activer la galerie",
    "disable": "Utiliser l’envoi uniquement",
    "disabled_title": "Choisissez comment Homey utilise ce cadre",
    "disabled_intro": "Le mode envoi uniquement est actif. Activez la galerie pour consulter les photos, si cette connexion Homey y est autorisée.",
    "permission_title": "Vérifiez l’autorisation sur le cadre",
    "permission_intro": "Homey doit être autorisé à consulter les photos pour ouvrir cette galerie.",
    "permission_step_frame": "Sur le cadre, ouvrez Paramètres → Mes amis.",
    "permission_step_friend": "Repérez « __name__ », le nom utilisé par cette connexion Homey.",
    "permission_step_access": "Vérifiez l’autorisation de consulter les photos. Leur gestion permet aussi de les supprimer.",
    "permission_step_check": "Revenez ensuite ici pour vérifier les accès.",
    "permission_no_popup": "Les autorisations concernent cette connexion Homey. Aucune demande n’est envoyée automatiquement au cadre.",
    "check_access": "Vérifier les autorisations",
    "checking": "Vérification des autorisations…",
    "read_only": "Vous pouvez consulter ces photos. Leur suppression demande aussi l’autorisation de les gérer.",
    "empty_title": "Une place pour de nouveaux souvenirs",
    "empty": "Ce cadre ne contient aucune photo à afficher.",
    "count": "__count__ éléments",
    "page": "Page __page__",
    "hidden": "Masquée",
    "visible": "Dans le diaporama",
    "video": "Vidéo",
    "greeting": "Carte de vœux",
    "preview": "Aperçu",
    "unknown_date": "Date non renseignée",
    "received": "Reçue le __date__",
    "on_frame": "Sur ce cadre",
    "close": "Fermer",
    "keep": "Garder la photo",
    "delete": "Supprimer définitivement",
    "delete_warning": "Cette photo sera supprimée définitivement du cadre sélectionné. Cette action est irréversible.",
    "deleting": "Suppression de cette photo…",
    "deleted": "La photo a été supprimée du cadre.",
    "delete_uncertain": "La suppression n’a pas été confirmée. Fermez cet aperçu et actualisez la galerie pour vérifier avant toute autre suppression.",
    "refresh_required": "Actualisez la galerie avant de supprimer une autre photo.",
    "stale": "La galerie a peut-être changé. Actualisez pour retrouver les dernières photos.",
    "error": "Impossible de charger la galerie. Touchez Actualiser pour réessayer.",
    "preview_error": "Impossible de charger cet aperçu. Actualisez la galerie pour réessayer.",
    "busy": "Une opération est déjà en cours. Réessayez dans un instant.",
    "denied": "L’accès n’a pas été accordé. Vérifiez les autorisations de cette connexion Homey sur le cadre.",
    "unavailable": "Le cadre est indisponible. Vérifiez sa connexion, puis actualisez.",
    "invalid": "Le cadre a renvoyé une réponse inattendue. Veuillez actualiser.",
    "pagination_label": "Pages de la galerie",
    "photo_label": "__kind__ · __date__ · __visibility__",
    "filter_type": "Contenu",
    "filter_visibility": "Diaporama",
    "filter_sort": "Trier par",
    "filter_all": "Tout",
    "filter_photos": "Photos",
    "filter_videos": "Vidéos",
    "filter_greetings": "Messages",
    "filter_visible": "Inclus dans le diaporama",
    "filter_hidden": "Masqués du diaporama",
    "sort_received_desc": "Réception : plus récents",
    "sort_received_asc": "Réception : plus anciens",
    "sort_captured_desc": "Prise de vue : plus récents",
    "sort_captured_asc": "Prise de vue : plus anciens",
    "hide": "Masquer du diaporama",
    "show": "Inclure dans le diaporama",
    "hiding": "Masquage en cours…",
    "showing": "Affichage dans le diaporama…",
    "visibility_changed": "Visibilité dans le diaporama mise à jour.",
    "visibility_uncertain": "Le changement n’a pas été confirmé. Actualisez la galerie avant toute autre modification.",
    "preview_budget": "Cet aperçu ne peut pas être chargé dans la mémoire disponible. Fermez un aperçu ou actualisez."
  },
  "nl": {
    "language": "nl",
    "display_photo": "Weergeven op de fotolijst",
    "photo_action_pending": "Verzoek wordt verwerkt…",
    "display_requested": "Weergaveverzoek verzonden naar de fotolijst.",
    "display_uncertain": "Het weergaveverzoek kon niet worden bevestigd. Controleer de fotolijst voordat je het opnieuw probeert.",
    "flow_photo_name": "Fotonaam in Flows",
    "flow_photo_hint": "Geef deze foto een naam om hem in een Flow te kiezen. Homey bewaart alleen de verwijzing.",
    "flow_photo_save": "Opslaan voor Flows",
    "flow_photo_remove": "Verwijderen uit Flows",
    "flow_photo_saved": "Deze foto is nu beschikbaar in Flows.",
    "flow_photo_removed": "De verwijzing is verwijderd uit Flows.",
    "flow_photo_limit": "De limiet van 64 opgeslagen fotoverwijzingen is bereikt.",
    "flow_photo_name_taken": "Een andere foto op deze lijst heeft al die naam.",
    "flow_photo_invalid": "Voer een naam voor deze foto in.",
    "title": "Je fotolijst, een stukje dichterbij",
    "intro": "Bekijk de foto’s op je fotolijst, hier in Homey.",
    "frame_label": "Fotolijst",
    "refresh": "Vernieuwen",
    "photos": "Foto’s",
    "previous": "Vorige",
    "next": "Volgende",
    "privacy": "Alleen de getoonde voorbeelden worden geladen. Ze worden tijdelijk bewaard voor weergave.",
    "loading_frames": "Je fotolijsten zoeken…",
    "loading_photos": "Foto’s laden…",
    "loading_preview": "Voorbeeld laden…",
    "no_frames": "Voeg een Frameo-fotolijst toe aan Homey om de galerij te openen.",
    "no_preview": "Voorbeeld niet beschikbaar",
    "video_thumbnail_unavailable": "Videominiatuur niet beschikbaar",
    "send_mode": "Alleen verzenden",
    "view_mode": "Bekijken",
    "manage_mode": "Bekijken en verwijderen",
    "friend_name": "Homey verschijnt op deze fotolijst als ‘__name__’.",
    "enable": "Galerij inschakelen",
    "disable": "Alleen verzenden gebruiken",
    "disabled_title": "Kies hoe Homey deze fotolijst gebruikt",
    "disabled_intro": "Alleen verzenden is ingeschakeld. Schakel de galerij in om foto’s te bekijken als deze Homey-verbinding daar toestemming voor heeft.",
    "permission_title": "Controleer de toestemming op de fotolijst",
    "permission_intro": "Homey heeft toestemming nodig om foto’s te bekijken voordat de galerij kan worden geopend.",
    "permission_step_frame": "Open op de fotolijst Instellingen → Mijn vrienden.",
    "permission_step_friend": "Zoek ‘__name__’, de naam die deze Homey-verbinding gebruikt.",
    "permission_step_access": "Controleer de toestemming om foto’s te bekijken. Met toestemming voor fotobeheer kun je ze ook verwijderen.",
    "permission_step_check": "Kom daarna hier terug om de toegang te controleren.",
    "permission_no_popup": "De toestemmingen gelden voor deze Homey-verbinding. Er wordt niet automatisch een verzoek naar de fotolijst gestuurd.",
    "check_access": "Toestemmingen controleren",
    "checking": "Toestemmingen controleren…",
    "read_only": "Je kunt deze foto’s bekijken. Om ze te verwijderen heb je ook toestemming voor fotobeheer nodig.",
    "empty_title": "Ruimte voor nieuwe herinneringen",
    "empty": "Deze fotolijst bevat geen foto’s om te tonen.",
    "count": "__count__ bestanden",
    "page": "Pagina __page__",
    "hidden": "Verborgen",
    "visible": "In de diavoorstelling",
    "video": "Video-opname",
    "greeting": "Wenskaart",
    "preview": "Voorbeeld",
    "unknown_date": "Datum niet opgegeven",
    "received": "Ontvangen op __date__",
    "on_frame": "Op deze fotolijst",
    "close": "Sluiten",
    "keep": "Foto behouden",
    "delete": "Definitief verwijderen",
    "delete_warning": "Deze foto wordt definitief van de geselecteerde fotolijst verwijderd. Dit kan niet ongedaan worden gemaakt.",
    "deleting": "Deze foto verwijderen…",
    "deleted": "De foto is van de fotolijst verwijderd.",
    "delete_uncertain": "De verwijdering is niet bevestigd. Sluit dit voorbeeld en vernieuw de galerij om de status te controleren voordat je iets anders verwijdert.",
    "refresh_required": "Vernieuw de galerij voordat je een andere foto verwijdert.",
    "stale": "De galerij kan zijn gewijzigd. Vernieuw deze om de nieuwste foto’s te zien.",
    "error": "De galerij kon niet worden geladen. Tik op Vernieuwen om het opnieuw te proberen.",
    "preview_error": "Dit voorbeeld kon niet worden geladen. Vernieuw de galerij om het opnieuw te proberen.",
    "busy": "Er wordt al een bewerking uitgevoerd. Probeer het zo nog eens.",
    "denied": "Er is geen toegang verleend. Controleer de toestemmingen voor deze Homey-verbinding op de fotolijst.",
    "unavailable": "De fotolijst is niet beschikbaar. Controleer de verbinding en vernieuw de galerij.",
    "invalid": "De fotolijst gaf een onverwacht antwoord. Vernieuw de galerij.",
    "pagination_label": "Pagina’s van de galerij",
    "photo_label": "__kind__ · __date__ · __visibility__",
    "filter_type": "Inhoud",
    "filter_visibility": "Diavoorstelling",
    "filter_sort": "Sorteren op",
    "filter_all": "Alles",
    "filter_photos": "Foto’s",
    "filter_videos": "Video’s",
    "filter_greetings": "Groeten",
    "filter_visible": "In de diavoorstelling",
    "filter_hidden": "Verborgen in diavoorstelling",
    "sort_received_desc": "Ontvangen: nieuwste eerst",
    "sort_received_asc": "Ontvangen: oudste eerst",
    "sort_captured_desc": "Gemaakt: nieuwste eerst",
    "sort_captured_asc": "Gemaakt: oudste eerst",
    "hide": "Verbergen in diavoorstelling",
    "show": "Opnemen in diavoorstelling",
    "hiding": "Verbergen…",
    "showing": "Opnemen in diavoorstelling…",
    "visibility_changed": "Zichtbaarheid in de diavoorstelling bijgewerkt.",
    "visibility_uncertain": "De wijziging is niet bevestigd. Vernieuw de galerij voordat je nog iets wijzigt.",
    "preview_budget": "Dit voorbeeld past niet in het beschikbare geheugen. Sluit een voorbeeld of vernieuw."
  },
  "de": {
    "language": "de",
    "display_photo": "Auf dem Bilderrahmen anzeigen",
    "photo_action_pending": "Anfrage wird bearbeitet…",
    "display_requested": "Anzeigeanfrage an den Bilderrahmen gesendet.",
    "display_uncertain": "Die Anzeigeanfrage konnte nicht bestätigt werden. Prüfe den Bilderrahmen, bevor du es erneut versuchst.",
    "flow_photo_name": "Name des Fotos in Flows",
    "flow_photo_hint": "Vergib einen Namen, um dieses Foto in einem Flow auszuwählen. Homey speichert nur den Verweis.",
    "flow_photo_save": "Für Flows speichern",
    "flow_photo_remove": "Aus Flows entfernen",
    "flow_photo_saved": "Dieses Foto ist jetzt in Flows verfügbar.",
    "flow_photo_removed": "Der Verweis wurde aus Flows entfernt.",
    "flow_photo_limit": "Das Limit von 64 gespeicherten Fotoverweisen ist erreicht.",
    "flow_photo_name_taken": "Ein anderes Foto auf diesem Rahmen hat bereits diesen Namen.",
    "flow_photo_invalid": "Gib einen Namen für dieses Foto ein.",
    "title": "Dein Bilderrahmen, ein Stück näher",
    "intro": "Sieh dir die Fotos auf deinem Bilderrahmen direkt in Homey an.",
    "frame_label": "Bilderrahmen",
    "refresh": "Aktualisieren",
    "photos": "Fotos",
    "previous": "Zurück",
    "next": "Weiter",
    "privacy": "Nur die angezeigten Vorschaubilder werden geladen. Sie werden vorübergehend für die Anzeige gespeichert.",
    "loading_frames": "Deine Bilderrahmen werden gesucht…",
    "loading_photos": "Fotos werden geladen…",
    "loading_preview": "Vorschau wird geladen…",
    "no_frames": "Füge einen Frameo-Bilderrahmen zu Homey hinzu, um seine Galerie zu öffnen.",
    "no_preview": "Vorschau nicht verfügbar",
    "video_thumbnail_unavailable": "Videovorschaubild nicht verfügbar",
    "send_mode": "Nur senden",
    "view_mode": "Ansehen",
    "manage_mode": "Ansehen und Löschen",
    "friend_name": "Homey erscheint auf diesem Bilderrahmen als „__name__“.",
    "enable": "Galerie aktivieren",
    "disable": "Nur Senden verwenden",
    "disabled_title": "Wähle, wie Homey diesen Bilderrahmen verwendet",
    "disabled_intro": "Nur Senden ist aktiviert. Aktiviere die Galerie, um Fotos anzusehen, sofern diese Homey-Verbindung dazu berechtigt ist.",
    "permission_title": "Prüfe die Berechtigung auf dem Bilderrahmen",
    "permission_intro": "Homey benötigt die Berechtigung zum Ansehen von Fotos, um die Galerie zu öffnen.",
    "permission_step_frame": "Öffne auf dem Bilderrahmen Einstellungen → Meine Freunde.",
    "permission_step_friend": "Suche „__name__“, den Namen dieser Homey-Verbindung.",
    "permission_step_access": "Prüfe die Berechtigung zum Ansehen von Fotos. Mit der Berechtigung zum Verwalten kannst du Fotos auch löschen.",
    "permission_step_check": "Kehre danach hierher zurück, um den Zugriff zu prüfen.",
    "permission_no_popup": "Die Berechtigungen gelten für diese Homey-Verbindung. Es wird keine automatische Anfrage an den Bilderrahmen gesendet.",
    "check_access": "Berechtigungen prüfen",
    "checking": "Berechtigungen werden geprüft…",
    "read_only": "Du kannst diese Fotos ansehen. Zum Löschen benötigst du zusätzlich die Berechtigung zum Verwalten von Fotos.",
    "empty_title": "Platz für neue Erinnerungen",
    "empty": "Auf diesem Bilderrahmen sind keine Fotos zum Anzeigen vorhanden.",
    "count": "__count__ Elemente",
    "page": "Seite __page__",
    "hidden": "Ausgeblendet",
    "visible": "In der Diashow",
    "video": "Videoaufnahme",
    "greeting": "Grußkarte",
    "preview": "Vorschau",
    "unknown_date": "Datum nicht angegeben",
    "received": "Empfangen am __date__",
    "on_frame": "Auf diesem Bilderrahmen",
    "close": "Schließen",
    "keep": "Foto behalten",
    "delete": "Endgültig löschen",
    "delete_warning": "Dieses Foto wird endgültig vom ausgewählten Bilderrahmen gelöscht. Dies kann nicht rückgängig gemacht werden.",
    "deleting": "Dieses Foto wird gelöscht…",
    "deleted": "Das Foto wurde vom Bilderrahmen gelöscht.",
    "delete_uncertain": "Die Löschung wurde nicht bestätigt. Schließe diese Vorschau und aktualisiere die Galerie, um den Status zu prüfen, bevor du weitere Fotos löschst.",
    "refresh_required": "Aktualisiere die Galerie, bevor du ein weiteres Foto löschst.",
    "stale": "Diese Galerie hat sich möglicherweise geändert. Aktualisiere sie, um die neuesten Fotos zu sehen.",
    "error": "Die Galerie konnte nicht geladen werden. Tippe auf Aktualisieren, um es erneut zu versuchen.",
    "preview_error": "Diese Vorschau konnte nicht geladen werden. Aktualisiere die Galerie und versuche es erneut.",
    "busy": "Ein anderer Vorgang läuft bereits. Versuche es gleich noch einmal.",
    "denied": "Der Zugriff wurde nicht erteilt. Prüfe die Berechtigungen dieser Homey-Verbindung auf dem Bilderrahmen.",
    "unavailable": "Der Bilderrahmen ist nicht verfügbar. Prüfe die Verbindung und aktualisiere die Galerie.",
    "invalid": "Der Bilderrahmen hat unerwartet geantwortet. Aktualisiere die Galerie.",
    "pagination_label": "Seiten der Galerie",
    "photo_label": "__kind__ · __date__ · __visibility__",
    "filter_type": "Inhalt",
    "filter_visibility": "Diashow",
    "filter_sort": "Sortieren nach",
    "filter_all": "Alle",
    "filter_photos": "Fotos",
    "filter_videos": "Videos",
    "filter_greetings": "Grüße",
    "filter_visible": "In der Diashow enthalten",
    "filter_hidden": "In der Diashow ausgeblendet",
    "sort_received_desc": "Empfangen: neueste zuerst",
    "sort_received_asc": "Empfangen: älteste zuerst",
    "sort_captured_desc": "Aufgenommen: neueste zuerst",
    "sort_captured_asc": "Aufgenommen: älteste zuerst",
    "hide": "Aus Diashow ausblenden",
    "show": "In Diashow aufnehmen",
    "hiding": "Wird ausgeblendet…",
    "showing": "Wird in Diashow aufgenommen…",
    "visibility_changed": "Sichtbarkeit in der Diashow aktualisiert.",
    "visibility_uncertain": "Die Änderung wurde nicht bestätigt. Aktualisiere die Galerie vor einer weiteren Änderung.",
    "preview_budget": "Diese Vorschau passt nicht in den verfügbaren Speicher. Schließe eine Vorschau oder aktualisiere."
  }
};

  function cleanText(value, length) {
    return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, length || 120) : '';
  }

  function mediaId(value) {
    if (typeof value === 'number' && Number.isSafeInteger(value)) value = String(value);
    return typeof value === 'string' && /^-?\d{1,20}$/.test(value) ? value : null;
  }

  function previewUrl(value) {
    if (!value || !['image/jpeg', 'image/png', 'image/webp'].includes(value.mime) || typeof value.data !== 'string'
      || value.data.length === 0 || value.data.length > Math.ceil(PREVIEW_LIMIT / 3) * 4
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data) || value.data.length % 4 !== 0
      || !Number.isInteger(value.bytes) || value.bytes < 1 || value.bytes > PREVIEW_LIMIT) throw new Error('INVALID_RESPONSE');
    const padding = value.data.endsWith('==') ? 2 : value.data.endsWith('=') ? 1 : 0;
    if (value.data.length / 4 * 3 - padding !== value.bytes) throw new Error('INVALID_RESPONSE');
    return 'data:' + value.mime + ';base64,' + value.data;
  }

  function create(options) {
    const Homey = options.Homey;
    const document = options.document;
    const window = options.window || {};
    const ids = ['gallery-page', 'frame-selector', 'refresh', 'access-badge', 'friend-name', 'permission-panel', 'permission-title',
      'permission-intro', 'permission-steps', 'permission-step-friend', 'enable-gallery', 'check-access', 'gallery-section', 'photo-count',
      'read-only-note', 'photo-grid', 'empty-state', 'pagination', 'previous-page', 'next-page', 'page-label', 'gallery-status',
      'gallery-error', 'disable-gallery', 'photo-dialog', 'dialog-title', 'dialog-close', 'dialog-image', 'dialog-preview-status',
      'dialog-details', 'dialog-caption', 'delete-warning', 'dialog-read-only', 'dialog-status', 'dialog-cancel', 'delete-photo',
      'toggle-visibility', 'filter-type', 'filter-visibility', 'filter-sort',
      'display-photo', 'flow-photo-panel', 'flow-photo-name', 'flow-photo-save', 'flow-photo-remove'];
    const el = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
    const listeners = [], pendingRequests = new Set();
    function supportedLanguage(value) {
      const language = typeof value === 'string' ? value.toLowerCase().split(/[-_]/)[0] : '';
      return ['fr', 'en', 'nl', 'de'].includes(language) ? language : null;
    }
    let homeyLanguage;
    try { homeyLanguage = supportedLanguage(Homey.__('gallery.language')); } catch (_) {}
    const lang = homeyLanguage || supportedLanguage(options.language)
      || supportedLanguage(window.navigator && window.navigator.language) || 'en';
    const t = (key, tokens) => {
      let value;
      try { value = Homey.__('gallery.' + key, tokens); } catch (_) {}
      if (!value || value === 'gallery.' + key || value === key) value = translations[lang][key] || translations.en[key] || key;
      return String(value).replace(/__([a-z_]+)__/g, (match, name) => tokens && tokens[name] !== undefined ? String(tokens[name]) : match);
    };
    let destroyed = false, initialized = false, generation = 0, loading = false, deleting = false, needsVerification = false;
    let frames = [], frame = null, items = [], revision = null, nextCursor = null, pageIndex = 0, cursors = [null];
    let previews = new Map(), tiles = new Map(), modal = null, dialogGeneration = 0, previousFocus = null;
    let previewQueue = [], activePreviews = 0;
    let active = options.active !== false;
    const filters = { type: 'all', visibility: 'all', sort: 'received_desc' };
    let observer = null;
    const loadingPreviews = new Set();

    function listen(target, type, handler) {
      target.addEventListener(type, handler);
      listeners.push(() => target.removeEventListener(type, handler));
    }

    function api(method, path, body) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const done = (err, value) => {
          if (settled) return;
          settled = true; clearTimeout(timer); pendingRequests.delete(done);
          err ? reject(err) : resolve(value);
        };
        const timer = setTimeout(() => done(new Error('TIMEOUT')), options.apiTimeoutMs || 210000);
        if (typeof timer.unref === 'function') timer.unref();
        pendingRequests.add(done);
        try {
          const promise = Homey.api(method, path, body || null, done);
          if (promise && typeof promise.then === 'function') promise.then(value => done(null, value), err => done(err));
        } catch (err) { done(err); }
      });
    }

    function errorText(error) {
      const code = String(error && (error.code || error.message) || '').toUpperCase();
      if (/PERMISSION|ACCESS|FORBIDDEN|UNAUTHORIZED/.test(code)) return t('denied');
      if (/BUSY|QUEUE/.test(code)) return t('busy');
      if (/UNAVAILABLE|TIMEOUT|OFFLINE/.test(code)) return t('unavailable');
      if (/INVALID_RESPONSE/.test(code)) return t('invalid');
      return t('error');
    }

    function announce(message, error) {
      el['gallery-status'].textContent = error ? '' : message || '';
      el['gallery-error'].textContent = error ? message : '';
      el['gallery-error'].hidden = !error;
    }

    function busy(value) {
      loading = value;
      el['frame-selector'].disabled = deleting || loading || !frames.length;
      el.refresh.disabled = deleting || loading;
      el['enable-gallery'].disabled = deleting || loading;
      el['check-access'].disabled = deleting || loading;
      el['disable-gallery'].disabled = deleting || loading;
      el['previous-page'].disabled = deleting || loading || pageIndex === 0;
      el['next-page'].disabled = deleting || loading || !nextCursor;
      el['photo-grid'].setAttribute('aria-busy', value ? 'true' : 'false');
      for (const id of ['filter-type', 'filter-visibility', 'filter-sort']) if (el[id]) el[id].disabled = deleting || loading;
    }

    function displayDate(value) {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return t('unknown_date');
      const date = new Date(value);
      if (!Number.isFinite(date.getTime())) return t('unknown_date');
      return date.toLocaleDateString(lang, { year: 'numeric', month: 'short', day: 'numeric' });
    }

    function kind(item) {
      const type = String(item.type).toLowerCase();
      if (type === '1' || type.includes('video')) return 'video';
      if (type === '2' || type.includes('greeting')) return 'greeting';
      return 'preview';
    }

    function normalizeFrame(value) {
      if (!value || typeof value.id !== 'string' || !value.id || value.id.length > 100) return null;
      return { id: value.id, name: cleanText(value.name) || 'Frameo', senderName: cleanText(value.senderName) || 'Homey',
        mayView: value.mayView === true, mayManage: value.mayManage === true, mode: value.mode === 'manage' ? 'manage' : 'send' };
    }

    function updateFrame(value) {
      const updated = normalizeFrame(value);
      if (!updated || !frame || updated.id !== frame.id) throw new Error('INVALID_RESPONSE');
      frame = updated;
      frames = frames.map(item => item.id === frame.id ? frame : item);
    }

    function showFrame() {
      const enabled = frame && frame.mode === 'manage';
      const allowed = enabled && frame.mayView;
      el['access-badge'].hidden = !frame;
      el['access-badge'].textContent = frame ? t(!enabled ? 'send_mode' : frame.mayManage ? 'manage_mode' : 'view_mode') : '';
      el['friend-name'].textContent = frame ? t('friend_name', { name: frame.senderName }) : '';
      el['permission-panel'].hidden = !frame || allowed;
      el['gallery-section'].hidden = !allowed;
      el['disable-gallery'].hidden = !enabled;
      el['enable-gallery'].hidden = !frame || enabled;
      el['check-access'].hidden = !enabled;
      el['permission-steps'].hidden = !enabled;
      el['permission-title'].textContent = t(enabled ? 'permission_title' : 'disabled_title');
      el['permission-intro'].textContent = t(enabled ? 'permission_intro' : 'disabled_intro');
      el['permission-step-friend'].textContent = frame ? t('permission_step_friend', { name: frame.senderName }) : '';
      el['read-only-note'].hidden = !allowed || frame.mayManage;
    }

    function closeDialog(user) {
      if (deleting && !destroyed) return;
      const previousId = modal?.item.id;
      dialogGeneration++;
      modal = null;
      el['photo-dialog'].hidden = true;
      el['dialog-image'].hidden = true;
      el['dialog-image'].removeAttribute('src');
      el['dialog-image'].onload = null;
      el['dialog-image'].onerror = null;
      el['dialog-caption'].textContent = '';
      el['dialog-caption'].hidden = true;
      document.body.classList.remove('dialog-open');
      el['gallery-page'].removeAttribute('aria-hidden');
      if (user && previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
      previousFocus = null;
      if (previousId && observer && !tiles.get(previousId)?.visible) releasePreview(previousId);
    }

    function clearPage() {
      generation++;
      closeDialog(false);
      previewQueue = [];
      if (observer) observer.disconnect();
      releaseTileImages();
      for (const id of [...previews.keys()]) releasePreview(id);
      tiles.clear();
      el['photo-grid'].replaceChildren();
      items = []; revision = null; nextCursor = null;
      el['photo-count'].textContent = '';
      el['empty-state'].hidden = true;
      el.pagination.hidden = true;
    }

    function releaseTileImages() {
      for (const parts of tiles.values()) {
        for (const child of Array.from(parts.cover.children)) {
          if (child.tagName !== 'IMG') continue;
          child.onload = null; child.onerror = null; child.removeAttribute('src');
        }
      }
    }

    function updateDeleteButton() {
      el['delete-photo'].disabled = deleting || !modal || kind(modal.item) === 'video' || !modal.decoded || !frame || !frame.mayManage || needsVerification || !revision;
      if (el['toggle-visibility']) el['toggle-visibility'].disabled = el['delete-photo'].disabled;
      updateDisplayControls();
    }

    function displaySelection() {
      if (!modal?.decoded || !['photo', 'picture', '0'].includes(String(modal.item.type)) || !frame?.mayManage || frame.id !== modal.frameId || !revision) return null;
      return { id: frame.id, mediaId: modal.item.id, revision };
    }

    function updateDisplayControls() {
      const selection = displaySelection();
      const disabled = deleting || needsVerification || !selection;
      el['display-photo'].hidden = el['flow-photo-panel'].hidden = !selection;
      el['display-photo'].disabled = el['flow-photo-name'].disabled = disabled;
      el['flow-photo-save'].disabled = disabled || !el['flow-photo-name'].value.trim();
      el['flow-photo-remove'].hidden = !modal?.item.flowName;
      el['flow-photo-remove'].disabled = disabled;
    }

    function releasePreview(id) {
      const entry = previews.get(id);
      if (!entry) return;
      const parts = tiles.get(id);
      if (parts) {
        for (const child of Array.from(parts.cover.children)) if (child.tagName === 'IMG') {
          child.onload = child.onerror = null; child.removeAttribute('src');
        }
        parts.cover.replaceChildren(); parts.tile.classList.remove('preview-loaded');
      }
      if (entry.blob && window.URL && typeof window.URL.revokeObjectURL === 'function') window.URL.revokeObjectURL(entry.url);
      previews.delete(id);
    }

    function retainPreview(id, value) {
      const dataUrl = previewUrl(value);
      const width = Number.isInteger(value.width) && value.width > 0 ? value.width : 2000;
      const height = Number.isInteger(value.height) && value.height > 0 ? value.height : 2000;
      const pixels = width * height;
      if (width > 2048 || height > 2048 || pixels > 4000000) throw new Error('INVALID_RESPONSE');
      const bytes = value.bytes;
      releasePreview(id);
      const used = () => [...previews.values()].reduce((sum, entry) => ({ bytes: sum.bytes + (entry.bytes || 0), pixels: sum.pixels + (entry.pixels || 0) }), { bytes: 0, pixels: 0 });
      let total = used();
      while (total.bytes + bytes > CACHE_BYTE_LIMIT || total.pixels + pixels > CACHE_PIXEL_LIMIT) {
        const candidate = [...previews.keys()].find(key => !modal || key !== modal.item.id);
        if (!candidate) throw new Error('PREVIEW_BUDGET');
        releasePreview(candidate); total = used();
      }
      let url = dataUrl, blob = false;
      if (window.URL && typeof window.URL.createObjectURL === 'function' && typeof window.atob === 'function' && typeof window.Blob === 'function') {
        const raw = window.atob(value.data);
        if (raw.length !== bytes) throw new Error('INVALID_RESPONSE');
        const data = new Uint8Array(raw.length);
        for (let index = 0; index < raw.length; index++) data[index] = raw.charCodeAt(index);
        url = window.URL.createObjectURL(new window.Blob([data], { type: value.mime })); blob = true;
      }
      const entry = { url, blob, bytes, pixels, caption: cleanText(value.caption, 1000) };
      previews.set(id, entry); return entry;
    }

    function queuePreview(item, priority) {
      if ((!priority && kind(item) === 'video') || !active || destroyed || previews.has(item.id) || loadingPreviews.has(generation + ':' + item.id)
        || previewQueue.some(task => task.item.id === item.id && task.version === generation)) return;
      const task = { item, version: generation, frameId: frame.id };
      priority ? previewQueue.unshift(task) : previewQueue.push(task);
      pumpPreviews();
    }

    function showDialogPreview() {
      if (!modal) return;
      const entry = previews.get(modal.item.id);
      const unavailable = kind(modal.item) === 'video' ? 'video_thumbnail_unavailable' : 'no_preview';
      el['dialog-image'].hidden = true;
      el['dialog-caption'].textContent = '';
      el['dialog-caption'].hidden = true;
      el['dialog-preview-status'].hidden = false;
      el['dialog-preview-status'].textContent = t(entry?.error ? unavailable : 'loading_preview');
      modal.decoded = false;
      updateDeleteButton();
      if (!entry || !entry.url) return;
      const version = ++dialogGeneration;
      const ready = () => {
        if (destroyed || !modal || version !== dialogGeneration) return;
        modal.decoded = true;
        el['dialog-image'].hidden = false;
        el['dialog-caption'].textContent = entry.caption;
        el['dialog-caption'].hidden = !entry.caption;
        el['dialog-preview-status'].hidden = true;
        updateDeleteButton();
      };
      el['dialog-image'].onload = ready;
      el['dialog-image'].onerror = () => {
        if (!modal || version !== dialogGeneration) return;
        modal.decoded = false;
        el['dialog-image'].hidden = true;
        el['dialog-preview-status'].hidden = false;
        el['dialog-caption'].textContent = '';
        el['dialog-caption'].hidden = true;
        el['dialog-preview-status'].textContent = t(unavailable);
        updateDeleteButton();
      };
      el['dialog-image'].src = entry.url;
      if (el['dialog-image'].complete && el['dialog-image'].naturalWidth > 0) ready();
    }

    function openDialog(item, tile) {
      if (destroyed || deleting || !frame || !items.includes(item)) return;
      previousFocus = tile;
      modal = { item, decoded: false, frameId: frame.id };
      el['flow-photo-name'].value = item.flowName || '';
      el['dialog-title'].textContent = frame.name;
      const video = kind(item) === 'video';
      el['dialog-details'].textContent = (video ? t('video') + ' · ' : '') +
        t('received', { date: displayDate(item.receiveDate || item.captureDate) }) + ' · ' + t(item.visible ? 'visible' : 'hidden');
      if (video && previews.get(item.id)?.error) previews.delete(item.id);
      el['delete-warning'].hidden = video || !frame.mayManage;
      el['dialog-read-only'].hidden = video || frame.mayManage;
      el['delete-photo'].hidden = video || !frame.mayManage;
      if (el['toggle-visibility']) {
        el['toggle-visibility'].hidden = video || !frame.mayManage;
        el['toggle-visibility'].textContent = t(item.visible ? 'hide' : 'show');
      }
      el['dialog-status'].textContent = needsVerification ? t('refresh_required') : '';
      el['photo-dialog'].hidden = false;
      el['gallery-page'].setAttribute('aria-hidden', 'true');
      document.body.classList.add('dialog-open');
      showDialogPreview();
      if (!previews.has(item.id)) queuePreview(item, true);
      el['dialog-close'].focus();
    }

    function renderTile(item) {
      const tile = document.createElement('button');
      tile.type = 'button'; tile.className = 'photo-tile' + (kind(item) === 'video' ? '' : ' loading') + (item.visible ? '' : ' photo-hidden');
      tile.setAttribute('aria-label', t('photo_label', { kind: t(kind(item)), date: displayDate(item.captureDate || item.receiveDate), visibility: t(item.visible ? 'visible' : 'hidden') }));
      const cover = document.createElement('span'); cover.className = 'photo-cover';
      const placeholder = document.createElement('span'); placeholder.className = 'photo-placeholder'; placeholder.textContent = kind(item) === 'video' ? '▷' : '▧'; placeholder.setAttribute('aria-hidden', 'true');
      cover.append(placeholder);
      const info = document.createElement('span'); info.className = 'photo-info';
      const date = document.createElement('span'); date.className = 'photo-date'; date.textContent = displayDate(item.captureDate || item.receiveDate);
      const state = document.createElement('span'); state.className = 'photo-state'; state.textContent = t(item.visible ? 'visible' : 'hidden');
      info.append(date, state); tile.append(cover, info);
      tile.addEventListener('click', () => openDialog(item, tile));
      el['photo-grid'].append(tile);
      tile.dataset.mediaId = item.id;
      tiles.set(item.id, { tile, cover, state, visible: !observer });
      if (observer) observer.observe(tile);
    }

    function paintPreview(item, entry) {
      const parts = tiles.get(item.id);
      if (!parts) return;
      parts.tile.classList.remove('loading');
      if (entry.url) {
        const image = document.createElement('img'); image.alt = ''; image.decoding = 'async';
        image.onload = () => { if (!destroyed && tiles.get(item.id) === parts) parts.tile.classList.add('preview-loaded'); };
        image.onerror = () => {
          if (destroyed || tiles.get(item.id) !== parts) return;
          parts.tile.classList.add('preview-error'); parts.state.textContent = t('no_preview');
        };
        image.src = entry.url;
        parts.cover.replaceChildren(image);
      } else {
        parts.tile.classList.add('preview-error');
        parts.state.textContent = t(kind(item) === 'video' ? 'video' : 'no_preview');
      }
      if (modal && modal.item === item) showDialogPreview();
    }

    function pumpPreviews() {
      while (active && !destroyed && !deleting && activePreviews < 2 && previewQueue.length) {
        const task = previewQueue.shift();
        if (task.version !== generation) continue;
        if (observer && !tiles.get(task.item.id)?.visible && modal?.item.id !== task.item.id) continue;
        const taskKey = task.version + ':' + task.item.id;
        if (loadingPreviews.has(taskKey)) continue;
        loadingPreviews.add(taskKey);
        activePreviews++;
        api('POST', '/gallery/preview', { id: task.frameId, mediaId: task.item.id }).then(value => {
          if (!active || destroyed || task.version !== generation || observer && !tiles.get(task.item.id)?.visible && modal?.item.id !== task.item.id) return;
          const entry = retainPreview(task.item.id, value);
          paintPreview(task.item, entry);
        }).catch(() => {
          if (destroyed || task.version !== generation) return;
          const entry = { error: true }; previews.set(task.item.id, entry); paintPreview(task.item, entry);
        }).finally(() => { loadingPreviews.delete(taskKey); activePreviews--; pumpPreviews(); });
      }
    }

    async function loadPage(cursor, requestedPage) {
      if (!active || destroyed || deleting || !frame || frame.mode !== 'manage' || !frame.mayView) return;
      clearPage();
      const version = generation, frameId = frame.id;
      busy(true); announce(t('loading_photos'));
      try {
        const result = await api('POST', '/gallery/list', { id: frameId, cursor: cursor || undefined, limit: PAGE_SIZE, ...filters });
        if (destroyed || version !== generation) return;
        if (!result || !Array.isArray(result.items) || result.items.length > PAGE_SIZE || typeof result.revision !== 'string' || !result.revision
          || (result.nextCursor != null && typeof result.nextCursor !== 'string')) throw new Error('INVALID_RESPONSE');
        const seen = new Set();
        items = result.items.map(value => {
          const id = mediaId(value && value.id);
          if (!id || seen.has(id)) throw new Error('INVALID_RESPONSE');
          seen.add(id);
          return { id, type: value.type, visible: value.visible === true, captureDate: value.captureDate, receiveDate: value.receiveDate,
            flowName: cleanText(value.flowName, 80) };
        });
        revision = result.revision;
        nextCursor = result.nextCursor || null;
        pageIndex = requestedPage;
        el['photo-count'].textContent = t('count', { count: Number.isSafeInteger(result.total) && result.total >= items.length ? result.total : items.length });
        el['page-label'].textContent = t('page', { page: pageIndex + 1 });
        el['empty-state'].hidden = items.length !== 0;
        el.pagination.hidden = pageIndex === 0 && !nextCursor;
        items.forEach(renderTile);
        previewQueue = observer ? [] : items.filter(item => kind(item) !== 'video').map(item => ({ item, version, frameId }));
        announce(''); pumpPreviews();
      } catch (err) {
        if (!destroyed && version === generation) announce(errorText(err), true);
      } finally { if (!destroyed && version === generation) busy(false); }
    }

    async function refresh() {
      if (destroyed || deleting || loading) return;
      clearPage(); needsVerification = false;
      const version = generation, selectedId = frame && frame.id;
      busy(true); announce(t('loading_frames'));
      try {
        const result = await api('GET', '/gallery/frames');
        if (destroyed || version !== generation) return;
        const values = Array.isArray(result) ? result : result && result.frames;
        if (!Array.isArray(values) || values.length > 64) throw new Error('INVALID_RESPONSE');
        frames = values.map(normalizeFrame).filter(Boolean);
        frame = frames.find(value => value.id === selectedId) || frames[0] || null;
        el['frame-selector'].replaceChildren();
        frames.forEach(value => {
          const option = document.createElement('option'); option.value = value.id; option.textContent = value.name; el['frame-selector'].append(option);
        });
        el['frame-selector'].value = frame ? frame.id : '';
        cursors = [null]; pageIndex = 0; showFrame();
        announce(frame ? '' : t('no_frames'));
        busy(false);
        if (frame && frame.mode === 'manage' && frame.mayView) await loadPage(null, 0);
      } catch (err) { if (!destroyed && version === generation) announce(errorText(err), true); }
      finally { if (!destroyed && version === generation) busy(false); }
    }

    async function changeMode(mode) {
      if (destroyed || deleting || loading || !frame) return;
      clearPage(); const version = generation, frameId = frame.id;
      busy(true); announce(t('checking'));
      try {
        const result = await api('POST', '/gallery/mode', { id: frameId, mode });
        if (destroyed || version !== generation) return;
        updateFrame(result && result.frame ? result.frame : { ...frame, mode: result && result.mode });
        cursors = [null]; pageIndex = 0; needsVerification = false; showFrame(); announce(''); busy(false);
        if (frame.mode === 'manage' && frame.mayView) await loadPage(null, 0);
      } catch (err) { if (!destroyed && version === generation) announce(errorText(err), true); }
      finally { if (!destroyed && version === generation) busy(false); }
    }

    async function checkAccess() {
      if (destroyed || deleting || loading || !frame) return;
      clearPage(); const version = generation, frameId = frame.id;
      busy(true); announce(t('checking'));
      try {
        const result = await api('POST', '/gallery/check-access', { id: frameId });
        if (destroyed || version !== generation) return;
        updateFrame(result && result.frame || result); showFrame(); announce(''); busy(false);
        if (frame.mode === 'manage' && frame.mayView) await loadPage(null, 0);
      } catch (err) { if (!destroyed && version === generation) announce(errorText(err), true); }
      finally { if (!destroyed && version === generation) busy(false); }
    }

    async function deletePhoto() {
      if (destroyed || deleting || needsVerification || !modal || !modal.decoded || !frame || !frame.mayManage || frame.id !== modal.frameId || !revision) return;
      const frameId = frame.id, id = modal.item.id, snapshot = revision;
      deleting = true; busy(loading); updateDeleteButton();
      el['dialog-close'].disabled = true; el['dialog-cancel'].disabled = true;
      el['dialog-status'].textContent = t('deleting');
      try {
        const result = await api('POST', '/gallery/delete', { id: frameId, mediaId: id, revision: snapshot, confirmation: 'delete' });
        if (destroyed) return;
        if (!result || result.deleted !== true || String(result.mediaId) !== id) throw new Error('INVALID_RESPONSE');
        deleting = false; closeDialog(false); cursors = [null]; pageIndex = 0;
        await loadPage(null, 0);
        if (!destroyed) {
          el.refresh.focus();
          if (!el['gallery-error'].textContent) announce(t('deleted'));
        }
      } catch (_) {
        if (destroyed) return;
        needsVerification = true;
        el['dialog-status'].textContent = t('delete_uncertain');
        announce(t('refresh_required'), true);
      } finally {
        deleting = false;
        if (!destroyed) {
          el['dialog-close'].disabled = false; el['dialog-cancel'].disabled = false;
          busy(false); updateDeleteButton(); pumpPreviews();
        }
      }
    }

    async function toggleVisibility() {
      if (!active || destroyed || deleting || needsVerification || !modal?.decoded || !frame?.mayManage || frame.id !== modal.frameId || !revision) return;
      const id = modal.item.id, visible = !modal.item.visible;
      deleting = true; busy(false); updateDeleteButton();
      el['dialog-close'].disabled = el['dialog-cancel'].disabled = true;
      el['dialog-status'].textContent = t(visible ? 'showing' : 'hiding');
      try {
        const result = await api('POST', '/gallery/visibility', { id: frame.id, mediaId: id, revision, visible, confirmation: 'visibility' });
        if (destroyed) return;
        if (!result || result.verified !== true || result.acknowledged !== true || result.mediaId !== id || result.visible !== visible) throw new Error('INVALID_RESPONSE');
        deleting = false; closeDialog(false); cursors = [null]; pageIndex = 0;
        await loadPage(null, 0);
        if (!destroyed && !el['gallery-error'].textContent) announce(t('visibility_changed'));
      } catch (_) {
        if (destroyed) return;
        needsVerification = true;
        el['dialog-status'].textContent = t('visibility_uncertain');
        announce(t('refresh_required'), true);
      } finally {
        deleting = false;
        if (!destroyed) {
          el['dialog-close'].disabled = el['dialog-cancel'].disabled = false;
          busy(false); updateDeleteButton(); pumpPreviews();
        }
      }
    }

    async function useSelectedPhoto(action) {
      const selection = displaySelection();
      if (!active || destroyed || deleting || needsVerification || !selection) return;
      const name = action === 'save' ? el['flow-photo-name'].value.trim() : null;
      if (action === 'save' && !name) return;
      deleting = true; busy(false); updateDeleteButton();
      el['dialog-close'].disabled = el['dialog-cancel'].disabled = true;
      el['dialog-status'].textContent = t('photo_action_pending');
      try {
        if (action === 'display') {
          const result = await api('POST', '/gallery/display', selection);
          if (destroyed) return;
          if (result?.requested !== true || result.mediaId !== selection.mediaId) throw new Error('DISPLAY_UNVERIFIED');
          el['dialog-status'].textContent = t('display_requested');
        } else {
          const result = await api('POST', '/gallery/flow-photo', { ...selection, name });
          if (destroyed) return;
          if (result?.name !== null && typeof result?.name !== 'string') throw new Error('INVALID_RESPONSE');
          modal.item.flowName = el['flow-photo-name'].value = cleanText(result.name, 80);
          el['dialog-status'].textContent = t(result.name ? 'flow_photo_saved' : 'flow_photo_removed');
        }
      } catch (error) {
        if (destroyed) return;
        const code = String(error?.code || error?.message || '');
        const key = action === 'display' && code === 'TIMEOUT' ? 'display_uncertain' : {
          DISPLAY_UNVERIFIED: 'display_uncertain', DISPLAY_PHOTO_LIMIT: 'flow_photo_limit',
          DISPLAY_PHOTO_NAME_TAKEN: 'flow_photo_name_taken', DISPLAY_PHOTO_INVALID: 'flow_photo_invalid',
          GALLERY_STALE: 'stale',
        }[code];
        el['dialog-status'].textContent = key ? t(key) : errorText(error);
      } finally {
        deleting = false;
        if (!destroyed) {
          el['dialog-close'].disabled = el['dialog-cancel'].disabled = false;
          busy(false); updateDeleteButton(); pumpPreviews();
        }
      }
    }

    function setActive(value) {
      const next = value === true;
      if (destroyed || active === next) return;
      active = next;
      if (!active) {
        previewQueue = [];
        if (!deleting) { clearPage(); busy(false); }
      } else if (initialized && !loading && !deleting) {
        return refresh();
      }
    }

    function keydown(event) {
      if (!modal) return;
      if (event.key === 'Escape') { event.preventDefault(); closeDialog(true); }
      if (event.key === 'Tab') {
        const focusable = [el['dialog-close'], el['flow-photo-name'], el['flow-photo-save'], el['flow-photo-remove'],
          el['display-photo'], el['dialog-cancel'], el['toggle-visibility'], el['delete-photo']].filter(value => value && !value.disabled && !value.hidden);
        if (!focusable.length) { event.preventDefault(); return; }
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }

    function init() {
      if (initialized || destroyed) return;
      initialized = true;
      if (typeof window.IntersectionObserver === 'function') observer = new window.IntersectionObserver(entries => {
        for (const entry of entries) {
          const id = entry.target.dataset.mediaId, parts = tiles.get(id);
          if (!parts) continue;
          parts.visible = entry.isIntersecting;
          if (parts.visible && active) {
            const item = items.find(item => item.id === id);
            if (item) queuePreview(item);
          } else if (modal?.item.id !== id) releasePreview(id);
        }
      }, { rootMargin: '100px' });
      document.documentElement.lang = lang;
      document.querySelectorAll('[data-gallery-i18n]').forEach(element => { element.textContent = t(element.dataset.galleryI18n); });
      el['dialog-close'].setAttribute('aria-label', t('close'));
      el.pagination.setAttribute('aria-label', t('pagination_label'));
      el.refresh.setAttribute('aria-label', t('refresh'));
      listen(el.refresh, 'click', refresh);
      listen(el['enable-gallery'], 'click', () => changeMode('manage'));
      listen(el['disable-gallery'], 'click', () => changeMode('send'));
      listen(el['check-access'], 'click', checkAccess);
      listen(el['frame-selector'], 'change', () => {
        if (deleting || loading) return;
        clearPage(); needsVerification = false;
        frame = frames.find(value => value.id === el['frame-selector'].value) || null;
        cursors = [null]; pageIndex = 0; showFrame(); announce('');
        if (frame && frame.mode === 'manage' && frame.mayView) loadPage(null, 0);
      });
      listen(el['previous-page'], 'click', () => { if (!loading && pageIndex > 0) loadPage(cursors[pageIndex - 1], pageIndex - 1); });
      listen(el['next-page'], 'click', () => {
        if (loading || !nextCursor) return;
        cursors[pageIndex + 1] = nextCursor;
        loadPage(nextCursor, pageIndex + 1);
      });
      listen(el['dialog-close'], 'click', () => closeDialog(true));
      listen(el['dialog-cancel'], 'click', () => closeDialog(true));
      listen(el['photo-dialog'], 'click', event => { if (event.target === el['photo-dialog']) closeDialog(true); });
      listen(el['delete-photo'], 'click', deletePhoto);
      listen(el['display-photo'], 'click', () => useSelectedPhoto('display'));
      listen(el['flow-photo-name'], 'input', updateDisplayControls);
      listen(el['flow-photo-save'], 'click', () => useSelectedPhoto('save'));
      listen(el['flow-photo-remove'], 'click', () => useSelectedPhoto('remove'));
      if (el['toggle-visibility']) listen(el['toggle-visibility'], 'click', toggleVisibility);
      for (const [id, key] of [['filter-type', 'type'], ['filter-visibility', 'visibility'], ['filter-sort', 'sort']]) if (el[id]) {
        el[id].value = filters[key];
        listen(el[id], 'change', () => {
          if (destroyed || deleting || loading) return;
          filters[key] = el[id].value; cursors = [null]; pageIndex = 0;
          return loadPage(null, 0);
        });
      }
      listen(document, 'keydown', keydown);
      if (typeof window.addEventListener === 'function') listen(window, 'pagehide', destroy);
      if (typeof Homey.on === 'function') Homey.on('gallery.changed', value => {
        if (destroyed || deleting || !frame || value && value.id && value.id !== frame.id) return;
        needsVerification = true; updateDeleteButton(); announce(t('stale'));
      });
      Homey.ready();
      return refresh();
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true; generation++; previewQueue = [];
      [...pendingRequests].forEach(done => done(new Error('ABORTED')));
      closeDialog(false); releaseTileImages();
      if (observer) observer.disconnect();
      for (const id of [...previews.keys()]) releasePreview(id);
      tiles.clear();
      el['photo-grid'].replaceChildren();
      listeners.splice(0).forEach(remove => remove());
    }

    return { init, refresh, destroy, setActive,
      cacheStats: () => [...previews.values()].reduce((sum, item) => ({ bytes: sum.bytes + (item.bytes || 0), pixels: sum.pixels + (item.pixels || 0), entries: sum.entries + 1 }), { bytes: 0, pixels: 0, entries: 0 }) };
  }

  return { create, translations, previewUrl };
}));
