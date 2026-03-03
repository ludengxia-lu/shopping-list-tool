import React, { useState, useRef, useEffect } from 'react';
import { GoogleGenAI, Type } from '@google/genai';
import { Upload, Search, Loader2, Trash2, CheckCircle2, AlertCircle, Package, Calendar, FileText, ArrowLeft, Clock, Image as ImageIcon } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { format, parseISO, isToday, isYesterday } from 'date-fns';

// Initialize Gemini
const ai = new GoogleGenAI({ 
  apiKey: import.meta.env.VITE_GEMINI_API_KEY 
});

interface ExtractedItem {
  id: string;
  phone: string;
  name: string;
  barcode: string;
  itemName: string;
  quantity: string;
  sourceImageId: string;
  date: string;
}

interface UploadedImage {
  id: string;
  url: string;
  file?: File;
  status: 'pending' | 'processing' | 'success' | 'error';
  errorMessage?: string;
  date: string;
}

type ViewState = 'home' | 'today-search' | 'today-upload' | 'history' | 'notes';

export default function App() {
  const [currentView, setCurrentView] = useState<ViewState>('home');
  const [selectedDate, setSelectedDate] = useState<string>(format(new Date(), 'yyyy-MM-dd'));
  const [availableDates, setAvailableDates] = useState<string[]>([]);
  const [images, setImages] = useState<UploadedImage[]>([]);
  const [extractedData, setExtractedData] = useState<ExtractedItem[]>([]);
  const [noteContent, setNoteContent] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSavingNote, setIsSavingNote] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const extractedDataRef = useRef<ExtractedItem[]>([]);

  useEffect(() => {
    extractedDataRef.current = extractedData;
  }, [extractedData]);

  const todayStr = format(new Date(), 'yyyy-MM-dd');

  // Load available dates
  const fetchDates = async () => {
    try {
      const res = await fetch('/api/dates');
      const dates = await res.json();
      if (!dates.includes(todayStr)) {
        setAvailableDates([todayStr, ...dates]);
      } else {
        setAvailableDates(dates);
      }
    } catch (error) {
      console.error("Failed to fetch dates", error);
      setAvailableDates([todayStr]);
    }
  };

  useEffect(() => {
    fetchDates();
  }, [todayStr]);

  // Load data for selected date
  useEffect(() => {
    const loadDateData = async () => {
      setIsLoading(true);
      try {
        const res = await fetch(`/api/data/${selectedDate}`);
        const data = await res.json();
        setImages(data.images || []);
        setExtractedData(data.items || []);
        setNoteContent(data.note || '');
      } catch (error) {
        console.error("Failed to load data", error);
        setImages([]);
        setExtractedData([]);
        setNoteContent('');
      } finally {
        setIsLoading(false);
      }
    };
    loadDateData();
  }, [selectedDate, currentView]); // Reload when view changes to ensure fresh data

  const handleSaveNote = async () => {
    setIsSavingNote(true);
    try {
      await fetch('/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: selectedDate, content: noteContent })
      });
    } catch (error) {
      console.error("Failed to save note", error);
    } finally {
      setIsSavingNote(false);
    }
  };

  const extractDataFromImage = async (image: UploadedImage, targetDate: string) => {
    try {
      // 1. Convert to base64
      const base64Data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve((reader.result as string).split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(image.file!);
      });

      // 2. Save image to backend as 'processing'
      setImages(prev => prev.map(img => img.id === image.id ? { ...img, status: 'processing' } : img));
      const imgRes = await fetch('/api/images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: image.id, base64: base64Data, date: targetDate, status: 'processing' })
      });
      const { url } = await imgRes.json();
      
      // Update local image URL to the server one
      setImages(prev => prev.map(img => img.id === image.id ? { ...img, url } : img));

      // 3. Call Gemini
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [
          {
            inlineData: {
              data: base64Data,
              mimeType: image.file!.type
            }
          },
          {
            text: "Extract the table data from this shopping list image. The columns are 手机号 (Phone Number), 姓名 (Name), 商品条码 (Barcode), 商品名称 (Item Name), and 数量 (Quantity). Some phone numbers and names span multiple rows; ensure every item has the correct phone and name associated with it. Return a JSON array of items."
          }
        ],
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                phone: { type: Type.STRING, description: "手机号" },
                name: { type: Type.STRING, description: "姓名" },
                barcode: { type: Type.STRING, description: "商品条码" },
                itemName: { type: Type.STRING, description: "商品名称" },
                quantity: { type: Type.STRING, description: "数量" }
              }
            }
          }
        }
      });

      const jsonStr = response.text?.trim() || "[]";
      const parsedData = JSON.parse(jsonStr);
      
      const newItems: ExtractedItem[] = parsedData.map((item: any) => ({
        id: crypto.randomUUID(),
        phone: item.phone || '',
        name: item.name || '',
        barcode: item.barcode || '',
        itemName: item.itemName || '',
        quantity: item.quantity || '',
        sourceImageId: image.id,
        date: targetDate
      }));

      // 4. Deduplicate against current state
      // Calculate unique items outside of setExtractedData so we can use them for the API call
      const currentData = extractedDataRef.current;
      const uniqueNewItems = newItems.filter(newItem => {
        return !currentData.some(existing => 
          existing.phone === newItem.phone &&
          existing.name === newItem.name &&
          existing.barcode === newItem.barcode &&
          existing.itemName === newItem.itemName &&
          existing.quantity === newItem.quantity
        );
      });

      // 5. Save items to backend
      if (uniqueNewItems.length > 0) {
        await fetch('/api/items', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: uniqueNewItems })
        });
        
        // Update local state immediately after saving
        setExtractedData(prev => [...prev, ...uniqueNewItems]);
        extractedDataRef.current = [...extractedDataRef.current, ...uniqueNewItems];
      }

      // 6. Update image status to 'success'
      await fetch(`/api/images/${image.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'success' })
      });
      setImages(prev => prev.map(img => img.id === image.id ? { ...img, status: 'success' } : img));
      fetchDates(); // Refresh available dates

    } catch (error) {
      console.error("Extraction error:", error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      await fetch(`/api/images/${image.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'error', errorMessage })
      });
      setImages(prev => prev.map(img => img.id === image.id ? { ...img, status: 'error', errorMessage } : img));
    }
  };

  const handleFiles = (files: FileList | null) => {
    if (!files) return;
    
    const newImages: UploadedImage[] = Array.from(files)
      .filter(file => file.type.startsWith('image/'))
      .map(file => ({
        id: crypto.randomUUID(),
        url: URL.createObjectURL(file), // Temporary local URL
        file,
        status: 'pending',
        date: selectedDate
      }));

    if (newImages.length > 0) {
      setImages(prev => [...prev, ...newImages]);
      // Process each new image
      newImages.forEach(img => extractDataFromImage(img, selectedDate));
    }
  };

  const removeImage = async (id: string) => {
    setImages(prev => prev.filter(img => img.id !== id));
    setExtractedData(prev => prev.filter(item => item.sourceImageId !== id));
    try {
      await fetch(`/api/images/${id}`, { method: 'DELETE' });
      fetchDates();
    } catch (error) {
      console.error("Failed to delete image", error);
    }
  };

  const filteredData = extractedData.filter(item => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    
    // Check if query is 4 digits (phone tail)
    const isPhoneTail = /^\d{4}$/.test(query);
    if (isPhoneTail && item.phone.endsWith(query)) {
      return true;
    }
    
    // Otherwise search in item name, phone, name, or barcode
    return (
      item.itemName.toLowerCase().includes(query) ||
      item.phone.includes(query) ||
      item.name.toLowerCase().includes(query) ||
      item.barcode.includes(query)
    );
  });

  const highlightMatch = (text: string, query: string) => {
    if (!query) return text;
    
    // If query is 4 digits, highlight if it matches the end of the phone number
    if (/^\d{4}$/.test(query) && text.endsWith(query)) {
      const start = text.slice(0, -4);
      const end = text.slice(-4);
      return (
        <>
          {start}
          <mark className="bg-yellow-200 text-neutral-900 rounded-sm px-0.5">{end}</mark>
        </>
      );
    }

    const parts = text.split(new RegExp(`(${query})`, 'gi'));
    return (
      <>
        {parts.map((part, i) => 
          part.toLowerCase() === query.toLowerCase() ? (
            <mark key={i} className="bg-yellow-200 text-neutral-900 rounded-sm px-0.5">{part}</mark>
          ) : (
            part
          )
        )}
      </>
    );
  };

  const formatDateLabel = (dateStr: string) => {
    try {
      const date = parseISO(dateStr);
      if (isToday(date)) return `今天 (${dateStr})`;
      if (isYesterday(date)) return `昨天 (${dateStr})`;
      return dateStr;
    } catch (e) {
      return dateStr;
    }
  };

  const navigateTo = (view: ViewState, date?: string) => {
    setSearchQuery('');
    if (date) {
      setSelectedDate(date);
    } else if (view === 'today-search' || view === 'today-upload') {
      setSelectedDate(todayStr);
    }
    setCurrentView(view);
  };

  // --- Render Helpers ---

  const renderHome = () => (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-8">
      <motion.button
        whileHover={{ scale: 1.02, y: -4 }}
        whileTap={{ scale: 0.98 }}
        onClick={() => navigateTo('today-search')}
        className="bg-white p-8 rounded-3xl border border-neutral-200 shadow-sm hover:shadow-md transition-all flex flex-col items-center justify-center text-center gap-4 group"
      >
        <div className="w-16 h-16 bg-indigo-50 text-indigo-600 rounded-2xl flex items-center justify-center group-hover:bg-indigo-600 group-hover:text-white transition-colors">
          <Search className="w-8 h-8" />
        </div>
        <div>
          <h2 className="text-xl font-semibold text-neutral-900">今日搜索查询</h2>
          <p className="text-neutral-500 mt-2 text-sm">查询今天已上传的订单信息</p>
        </div>
      </motion.button>

      <motion.button
        whileHover={{ scale: 1.02, y: -4 }}
        whileTap={{ scale: 0.98 }}
        onClick={() => navigateTo('today-upload')}
        className="bg-white p-8 rounded-3xl border border-neutral-200 shadow-sm hover:shadow-md transition-all flex flex-col items-center justify-center text-center gap-4 group"
      >
        <div className="w-16 h-16 bg-emerald-50 text-emerald-600 rounded-2xl flex items-center justify-center group-hover:bg-emerald-600 group-hover:text-white transition-colors">
          <Upload className="w-8 h-8" />
        </div>
        <div>
          <h2 className="text-xl font-semibold text-neutral-900">上传今日订单</h2>
          <p className="text-neutral-500 mt-2 text-sm">拍照或上传今天的购物单图片</p>
        </div>
      </motion.button>

      <motion.button
        whileHover={{ scale: 1.02, y: -4 }}
        whileTap={{ scale: 0.98 }}
        onClick={() => navigateTo('history')}
        className="bg-white p-8 rounded-3xl border border-neutral-200 shadow-sm hover:shadow-md transition-all flex flex-col items-center justify-center text-center gap-4 group"
      >
        <div className="w-16 h-16 bg-amber-50 text-amber-600 rounded-2xl flex items-center justify-center group-hover:bg-amber-600 group-hover:text-white transition-colors">
          <Clock className="w-8 h-8" />
        </div>
        <div>
          <h2 className="text-xl font-semibold text-neutral-900">往期订单记录</h2>
          <p className="text-neutral-500 mt-2 text-sm">查看和搜索之前每天的订单</p>
        </div>
      </motion.button>

      <motion.button
        whileHover={{ scale: 1.02, y: -4 }}
        whileTap={{ scale: 0.98 }}
        onClick={() => navigateTo('notes')}
        className="bg-white p-8 rounded-3xl border border-neutral-200 shadow-sm hover:shadow-md transition-all flex flex-col items-center justify-center text-center gap-4 group"
      >
        <div className="w-16 h-16 bg-rose-50 text-rose-600 rounded-2xl flex items-center justify-center group-hover:bg-rose-600 group-hover:text-white transition-colors">
          <FileText className="w-8 h-8" />
        </div>
        <div>
          <h2 className="text-xl font-semibold text-neutral-900">我的备注</h2>
          <p className="text-neutral-500 mt-2 text-sm">记录每天的重要事项和备忘</p>
        </div>
      </motion.button>
    </div>
  );

  const renderDataTable = () => (
    <div className="bg-white rounded-2xl border border-neutral-200 shadow-sm overflow-hidden mt-6">
      <div className="p-4 border-b border-neutral-200 bg-neutral-50/50 flex items-center gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-neutral-400" />
          <input 
            type="text" 
            placeholder="搜索手机尾号 (如: 1702) 或 商品名称..." 
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-neutral-200 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 outline-none transition-all bg-white"
          />
        </div>
        <div className="text-sm text-neutral-500">
          共 {filteredData.length} 条记录
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-neutral-200 bg-neutral-50 text-sm font-medium text-neutral-500">
              <th className="px-6 py-4 whitespace-nowrap">手机号</th>
              <th className="px-6 py-4 whitespace-nowrap">姓名</th>
              <th className="px-6 py-4 whitespace-nowrap">商品条码</th>
              <th className="px-6 py-4 min-w-[300px]">商品名称</th>
              <th className="px-6 py-4 whitespace-nowrap text-right">数量</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {isLoading ? (
              <tr>
                <td colSpan={5} className="px-6 py-12 text-center text-neutral-500">
                  <div className="flex flex-col items-center justify-center">
                    <Loader2 className="w-8 h-8 text-indigo-500 animate-spin mb-3" />
                    <p>加载中...</p>
                  </div>
                </td>
              </tr>
            ) : filteredData.length > 0 ? (
              filteredData.map((item) => (
                <tr key={item.id} className="hover:bg-neutral-50/50 transition-colors">
                  <td className="px-6 py-4 whitespace-nowrap font-mono text-sm text-neutral-900">
                    {highlightMatch(item.phone, searchQuery)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-neutral-900">
                    {highlightMatch(item.name, searchQuery)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap font-mono text-xs text-neutral-500">
                    {highlightMatch(item.barcode, searchQuery)}
                  </td>
                  <td className="px-6 py-4 text-sm text-neutral-900">
                    {highlightMatch(item.itemName, searchQuery)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-neutral-900 text-right">
                    {item.quantity}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={5} className="px-6 py-12 text-center text-neutral-500">
                  {extractedData.length === 0 ? (
                    <div className="flex flex-col items-center justify-center">
                      <Package className="w-12 h-12 text-neutral-300 mb-3" />
                      <p>暂无数据，请先上传购物单照片</p>
                      {currentView === 'today-search' && (
                        <button 
                          onClick={() => navigateTo('today-upload')}
                          className="mt-4 px-6 py-2 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition-colors"
                        >
                          去上传
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center">
                      <Search className="w-12 h-12 text-neutral-300 mb-3" />
                      <p>没有找到匹配的记录</p>
                    </div>
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );

  const renderUploadSection = () => (
    <div className="mt-6 space-y-6">
      <div 
        className={`border-2 border-dashed rounded-2xl p-8 text-center transition-colors ${isDragging ? 'border-indigo-500 bg-indigo-50' : 'border-neutral-200 bg-white hover:border-neutral-300'}`}
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => { e.preventDefault(); setIsDragging(false); handleFiles(e.dataTransfer.files); }}
      >
        <Upload className="w-10 h-10 text-neutral-400 mx-auto mb-4" />
        <p className="text-neutral-600 font-medium">点击或拖拽图片到此处上传</p>
        <p className="text-neutral-400 text-sm mt-1">支持 JPG, PNG 格式</p>
        <input 
          type="file" 
          ref={fileInputRef} 
          className="hidden" 
          multiple 
          accept="image/*"
          onChange={(e) => handleFiles(e.target.files)}
        />
        <button 
          onClick={() => fileInputRef.current?.click()}
          className="mt-6 px-6 py-2.5 bg-neutral-900 text-white rounded-xl font-medium hover:bg-neutral-800 transition-colors cursor-pointer"
        >
          选择图片
        </button>
      </div>

      {/* Uploaded Images Status */}
      {images.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
          <AnimatePresence>
            {images.map(img => (
              <motion.div 
                key={img.id}
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                className="relative group rounded-xl overflow-hidden border border-neutral-200 bg-white aspect-square flex flex-col"
              >
                <img src={img.url} alt="Uploaded" className="w-full h-full object-cover" />
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                  <button 
                    onClick={() => removeImage(img.id)}
                    className="p-2 bg-white/20 hover:bg-red-500 text-white rounded-full backdrop-blur-sm transition-colors cursor-pointer"
                  >
                    <Trash2 className="w-5 h-5" />
                  </button>
                </div>
                
                {/* Status Indicator */}
                <div className="absolute bottom-2 right-2 flex items-center justify-center">
                  {img.status === 'pending' && <div className="w-6 h-6 rounded-full bg-white/80 backdrop-blur-sm flex items-center justify-center"><Loader2 className="w-4 h-4 text-neutral-600 animate-spin" /></div>}
                  {img.status === 'processing' && <div className="w-6 h-6 rounded-full bg-white/80 backdrop-blur-sm flex items-center justify-center"><Loader2 className="w-4 h-4 text-indigo-600 animate-spin" /></div>}
                  {img.status === 'success' && <div className="w-6 h-6 rounded-full bg-emerald-500 flex items-center justify-center"><CheckCircle2 className="w-4 h-4 text-white" /></div>}
                  {img.status === 'error' && <div className="w-6 h-6 rounded-full bg-red-500 flex items-center justify-center" title={img.errorMessage}><AlertCircle className="w-4 h-4 text-white" /></div>}
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}
    </div>
  );

  const renderNotes = () => (
    <div className="mt-6 bg-white rounded-2xl border border-neutral-200 shadow-sm overflow-hidden flex flex-col h-[500px]">
      <div className="p-4 border-b border-neutral-200 bg-neutral-50 flex items-center justify-between">
        <div className="flex items-center gap-2 text-neutral-700 font-medium">
          <FileText className="w-5 h-5" />
          <span>{formatDateLabel(selectedDate)} 备注</span>
        </div>
        <button 
          onClick={handleSaveNote}
          disabled={isSavingNote || isLoading}
          className="px-4 py-1.5 bg-neutral-900 text-white text-sm font-medium rounded-lg hover:bg-neutral-800 disabled:opacity-50 transition-colors flex items-center gap-2"
        >
          {isSavingNote ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
          保存
        </button>
      </div>
      <textarea
        value={noteContent}
        onChange={(e) => setNoteContent(e.target.value)}
        placeholder="在这里记录今天的事项..."
        className="flex-1 p-6 w-full resize-none outline-none text-neutral-700 leading-relaxed"
        disabled={isLoading}
      />
    </div>
  );

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900 font-sans">
      <div className="max-w-6xl mx-auto p-6 space-y-6">
        {/* Header */}
        <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-neutral-200">
          <div className="flex items-center gap-4">
            {currentView !== 'home' && (
              <button 
                onClick={() => navigateTo('home')}
                className="p-2 hover:bg-neutral-200 rounded-full transition-colors text-neutral-600"
              >
                <ArrowLeft className="w-6 h-6" />
              </button>
            )}
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 flex items-center gap-2">
                <Package className="w-6 h-6 text-indigo-600" />
                购物单管理系统
              </h1>
            </div>
          </div>
          
          {/* Date Selector (Only show in History or Notes view) */}
          {(currentView === 'history' || currentView === 'notes') && (
            <div className="flex items-center gap-3">
              <div className="relative">
                <select 
                  value={selectedDate}
                  onChange={(e) => setSelectedDate(e.target.value)}
                  className="appearance-none pl-10 pr-8 py-2 bg-white border border-neutral-200 rounded-xl font-medium text-neutral-700 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 cursor-pointer shadow-sm transition-all"
                >
                  {availableDates.map(date => (
                    <option key={date} value={date}>{formatDateLabel(date)}</option>
                  ))}
                </select>
                <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-500 pointer-events-none" />
                <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none">
                  <svg className="w-4 h-4 text-neutral-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7"></path></svg>
                </div>
              </div>
            </div>
          )}
        </header>

        {/* Main Content Area */}
        <main>
          <AnimatePresence mode="wait">
            <motion.div
              key={currentView}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.2 }}
            >
              {currentView === 'home' && renderHome()}
              
              {currentView === 'today-search' && (
                <div>
                  <h2 className="text-xl font-semibold mb-2 flex items-center gap-2">
                    <Search className="w-5 h-5 text-indigo-500" />
                    今日搜索查询
                  </h2>
                  {renderDataTable()}
                </div>
              )}

              {currentView === 'today-upload' && (
                <div>
                  <h2 className="text-xl font-semibold mb-2 flex items-center gap-2">
                    <Upload className="w-5 h-5 text-emerald-500" />
                    上传今日订单
                  </h2>
                  {renderUploadSection()}
                </div>
              )}

              {currentView === 'history' && (
                <div>
                  <h2 className="text-xl font-semibold mb-2 flex items-center gap-2">
                    <Clock className="w-5 h-5 text-amber-500" />
                    往期订单记录
                  </h2>
                  {renderDataTable()}
                </div>
              )}

              {currentView === 'notes' && (
                <div>
                  <h2 className="text-xl font-semibold mb-2 flex items-center gap-2">
                    <FileText className="w-5 h-5 text-rose-500" />
                    我的备注
                  </h2>
                  {renderNotes()}
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
    </div>
  );
}
